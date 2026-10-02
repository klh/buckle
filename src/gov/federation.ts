// src/gov/federation.ts — W154 federation phase 1: hub policy distribution +
// spoke pull. W193: NO anonymous pulls — every federation request
// authenticates (GETs demand buckle:spoke:READ_); presented credentials are
// always validated (invalid bearer = 401, never downgraded); POST requires
// buckle:spoke:WRITE_. The manifest is SIGNED (W193): the hub's RS256
// identity signs the exact response bytes (detached JWS in
// x-buckle-manifest-signature); spokes verify via /.well-known/jwks.json —
// authenticity never rests on transport auth. Visibility law: spoke-private
// models never appear —
// structural (hub cannot see them) + defensive `visibility: spoke-private`.
import { Database } from "bun:sqlite";
import { YAML } from "bun";
import type { GatewayPolicy } from "../policy.ts";
import type { UpstreamPool } from "../upstreams.ts";
import { readFileSync } from "node:fs";
import { buildModels } from "./federation-entitlements.ts";
import {
	buildRules,
	crQueue,
	declareCR,
	type CrProbe,
	type FedManifest,
	manifestVersion,
	transitionCR,
} from "./federation-manifest.ts";
import { applyGovernanceSchema } from "./schema.ts";
import { authError, type Principal } from "./middleware.ts";
import { hasScope } from "./scopes.ts";
import type { ManifestSigner } from "./federation-signing.ts";

export interface FederationOpts {
	dbPath: string;
	policy: GatewayPolicy;
	pool: UpstreamPool;
	/** W160: the routing-policy.yaml path — the verification probe re-reads
	 *  this surface from disk before a CR may report `verified`. */
	policyPath?: string;
	/** W193: RS256 manifest-signing identity — JWKS serve + detached-JWS
	 *  signature over the exact manifest bytes (null = serve unsigned). */
	signer?: ManifestSigner;
}

export interface CrRow {
	id: string;
	action: string;
	target: string;
	declared_at: string;
	state: string;
	note: string | null;
	updated_at: number | null;
	reported_at: number | null;
	/** W160: the declared change (JSON) + origination record (JSON). */
	payload: string | null;
	origin: string | null;
	verified_at: number | null;
	/** W193 claim binding: the first spoke report binds claimed_by (other
	 *  non-admin principals 403 buckle.cr_claimed; hub-admin moves anything). */
	claimed_by: string | null;
	claimed_at: number | null;
}

/** The principal a gate-authenticated request carries (WeakMap stash — no
 *  request mutation, nothing leaks into headers). */
const PRINCIPALS = new WeakMap<Request, Principal>();

export function stashPrincipal(req: Request, p: Principal): void {
	PRINCIPALS.set(req, p);
}

export function principalOf(req: Request): Principal | null {
	return PRINCIPALS.get(req) ?? null;
}

/** Non-auth error envelope (same shape as the admin API's bad()). */
function bad(status: number, code: string, why: string): Response {
	return Response.json(
		{ error: { code, message: `belt: ${code} — ${why}` } },
		{ status },
	);
}

function str(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

/** W160: the built-in policy-revision probe — RE-READS routing-policy.yaml
 *  from disk at verify time (the hub re-reads the target surface; a spoke's
 *  word alone never grants `verified`). Registered for `policy@N` and
 *  `routing-policy@N` targets (longest-prefix match). */
function policyRevisionProbe(policyPath: string | undefined): CrProbe {
	return (cr: CrRow): { ok: boolean; why: string | null } => {
		const m = /@(\d+)$/.exec(cr.target);
		if (m === null)
			return { ok: false, why: `no revision in target '${cr.target}'` };
		const want = Number(m[1]);
		if (policyPath === undefined)
			return { ok: false, why: "no policy surface wired on this hub" };
		let have = 0;
		try {
			// doc-level `version` — parsePolicy keeps only the gateway block
			const doc = YAML.parse(readFileSync(policyPath, "utf8")) as {
				version?: number;
			} | null;
			have = doc?.version ?? 0;
		} catch (e) {
			return { ok: false, why: `policy surface unreadable: ${String(e)}` };
		}
		return have >= want
			? { ok: true, why: null }
			: {
					ok: false,
					why: `hub policy revision ${String(have)} < CR target ${String(want)}`,
				};
	};
}

export class Federation {
	readonly db: Database;
	private readonly policy: GatewayPolicy;
	private readonly pool: UpstreamPool;
	/** W193: the hub signing identity (JWKS + manifest signatures). */
	readonly signer: ManifestSigner | null;
	/** W160 verification probes, by target prefix (longest match wins). */
	private readonly probes = new Map<string, CrProbe>();

	constructor(opts: FederationOpts) {
		this.db = new Database(opts.dbPath, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		applyGovernanceSchema(this.db);
		this.policy = opts.policy;
		this.pool = opts.pool;
		this.signer = opts.signer ?? null;
		const rev = policyRevisionProbe(opts.policyPath);
		this.registerProbe("policy@", rev);
		this.registerProbe("routing-policy@", rev);
	}

	/** Register a verification probe for targets with the given prefix. */
	registerProbe(prefix: string, probe: CrProbe): void {
		this.probes.set(prefix, probe);
	}

	/** Run the probe matching this CR's target (longest registered prefix);
	 *  no match = honest failure — verified is never granted on faith. */
	private runProbe(cr: CrRow): { ok: boolean; why: string | null } {
		let best: string | null = null;
		for (const prefix of this.probes.keys()) {
			if (!cr.target.startsWith(prefix)) continue;
			if (best === null || prefix.length > best.length) best = prefix;
		}
		if (best === null)
			return {
				ok: false,
				why: `no verification probe registered for target '${cr.target}'`,
			};
		const probe = this.probes.get(best);
		if (probe === undefined)
			return { ok: false, why: `probe gap for '${cr.target}'` };
		return probe(cr);
	}

	/** The manifest payload: content-addressed version + rules + CR queue. */
	manifest(): FedManifest {
		const rules = buildRules(this.policy);
		return {
			version: manifestVersion(rules),
			rules,
			cr_queue: crQueue(this.db),
		};
	}

	/** Echo-menu entitlements: hub menu only, team ceilings when the pull
	 *  presents a team-carrying principal. */
	entitlements(p: Principal | null): Record<string, unknown> {
		const models = buildModels(this.pool, this.policy.tags ?? {});
		const ceilings = p?.team ? this.teamCeilings(p.team) : null;
		return { models, ceilings };
	}

	/** W141 team ceilings read through this handle (teams table is in the
	 *  shared governance schema). */
	private teamCeilings(
		teamId: string,
	): { rpm: number | null; tpm: number | null } | null {
		const r = this.db
			.query("SELECT rpm_ceiling, tpm_ceiling FROM teams WHERE team_id = ?")
			.get(teamId) as {
			rpm_ceiling: number | null;
			tpm_ceiling: number | null;
		} | null;
		if (r === null) return null;
		return { rpm: r.rpm_ceiling, tpm: r.tpm_ceiling };
	}

	/** W193: the manifest response — the hub signs the EXACT response bytes
	 *  (detached JWS in x-buckle-manifest-signature). Unsigned only when no
	 *  signing identity is wired (spokes degrade honestly). */
	private manifestResponse(): Response {
		const body = JSON.stringify(this.manifest());
		const headers: Record<string, string> = {
			"content-type": "application/json; charset=utf-8",
		};
		if (this.signer !== null)
			headers["x-buckle-manifest-signature"] = this.signer.sign(
				new TextEncoder().encode(body),
			);
		return new Response(body, { headers });
	}

	/** Route dispatch. CR delivery confirmation POST carries the spoke's
	 *  principal (gate enforces buckle:spoke:WRITE_; auth-off dev refuses
	 *  honestly when no principal ever got stashed). */
	async handle(req: Request, p: Principal | null): Promise<Response> {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname === "/federation/policy-manifest")
			return this.manifestResponse();
		if (req.method === "GET" && url.pathname === "/federation/entitlements")
			return Response.json(this.entitlements(p));
		if (req.method === "POST" && url.pathname === "/federation/cr")
			return this.crDeclare(req, p);
		if (req.method === "GET" && url.pathname === "/federation/cr")
			return this.crList(p);
		const cr = /^\/federation\/cr\/([^/]+)\/status$/.exec(url.pathname);
		if (req.method === "POST" && cr !== null)
			return this.crStatus(req, decodeURIComponent(cr[1] ?? ""), p);
		return this.notFound(`${req.method} ${url.pathname}`);
	}

	/** Spoke-reported CR transition: {state, note?} body → lifecycle-enforced
	 *  update. 401 no principal · 400 bad body · 404 unknown id · 409 illegal
	 *  transition · 200 row. */
	private async crStatus(
		req: Request,
		id: string,
		p: Principal | null,
	): Promise<Response> {
		if (p === null)
			return authError(401, "buckle.auth_missing", "missing bearer token");
		const body = (await req.json().catch(() => null)) as Record<
			string,
			unknown
		> | null;
		if (body === null) return bad(400, "buckle.bad_body", "invalid JSON body");
		const state = typeof body.state === "string" ? body.state : "";
		const note = typeof body.note === "string" ? body.note : null;
		const out = transitionCR(
			this.db,
			id,
			state,
			note,
			(cr) => this.runProbe(cr),
			{
				id: p.keyId,
				admin: p.kind === "root" || hasScope(p.scopes, "buckle:admin:WRITE_"),
			},
		);
		if (!out.ok) return bad(out.status, out.code, out.why);
		return Response.json({
			id,
			state: out.row.state,
			reported_at: out.row.reported_at,
		});
	}

	/** W160 CR declare guard: HUB-ADMIN-ONLY — buckle:admin:WRITE_ is demanded
	 *  at the gate AND here; the re-check is the structural
	 *  spoke-cannot-declare guard. Returns the rejection or null. */
	private crDeclareGuard(p: Principal | null): Response | null {
		if (p === null)
			return authError(401, "buckle.auth_missing", "missing bearer token");
		if (!hasScope(p.scopes, "buckle:admin:WRITE_"))
			return authError(
				403,
				"buckle.insufficient_scope",
				"declaring CRs requires buckle:admin:WRITE_ (hub-admin capability; spokes report status only)",
			);
		return null;
	}

	/** W160 CR declare: guard (401/403) → body → seam; 422 private-domain. */
	private async crDeclare(
		req: Request,
		p: Principal | null,
	): Promise<Response> {
		const guard = this.crDeclareGuard(p);
		if (guard !== null) return guard;
		const body = (await req.json().catch(() => null)) as Record<
			string,
			unknown
		> | null;
		if (body === null) return bad(400, "buckle.bad_body", "invalid JSON body");
		const action = str(body.action);
		const target = str(body.target);
		if (action === null || target === null)
			return bad(400, "buckle.bad_body", "action and target are required");
		const id =
			str(body.id) ??
			`cr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		const o = body.origin as Record<string, unknown> | null | undefined;
		const hasOrigin = o !== null && typeof o === "object" && !Array.isArray(o);
		const out = declareCR(this.db, {
			id,
			action,
			target,
			payload: body.payload,
			origin: {
				system:
					(hasOrigin && typeof o.system === "string" ? o.system : null) ??
					"belt",
				actor:
					(hasOrigin && typeof o.actor === "string" ? o.actor : null) ??
					p?.actor ??
					p?.keyId ??
					"unknown",
				// pass the declared origin through VERBATIM so the structural
				// domain guard sees private markers carried on it too
				...(hasOrigin ? o : {}),
			} as { system: string; actor: string },
		});
		if (!out.ok)
			return bad(
				out.code === "buckle.cr_private_domain" ? 422 : 400,
				out.code,
				out.why,
			);
		return Response.json(this.crOut(out.row), { status: 201 });
	}

	/** W160 CR list: hub-admin read (buckle:admin:READ_; WRITE_ implies). */
	private crList(p: Principal | null): Response {
		if (p === null)
			return authError(401, "buckle.auth_missing", "missing bearer token");
		if (!hasScope(p.scopes, "buckle:admin:READ_"))
			return authError(
				403,
				"buckle.insufficient_scope",
				"requires buckle:admin:READ_",
			);
		return Response.json({
			cr_queue: crQueue(this.db).map((r) => this.crOut(r)),
		});
	}

	/** Wire-format row: payload/origin storage JSON → objects. */
	private crOut(r: CrRow): Record<string, unknown> {
		const parse = (s: string | null): unknown => {
			if (s === null) return null;
			try {
				return JSON.parse(s) as unknown;
			} catch {
				return s;
			}
		};
		return {
			id: r.id,
			action: r.action,
			target: r.target,
			declared_at: r.declared_at,
			state: r.state,
			note: r.note,
			payload: parse(r.payload),
			origin: parse(r.origin),
			updated_at: r.updated_at,
			reported_at: r.reported_at,
			verified_at: r.verified_at,
			claimed_by: r.claimed_by,
			claimed_at: r.claimed_at,
		};
	}

	/** 404 envelope in the admin API's shape. */
	private notFound(what: string): Response {
		return Response.json(
			{
				error: {
					code: "buckle.no_route",
					message: `no federation route: ${what}`,
				},
			},
			{ status: 404 },
		);
	}
}
