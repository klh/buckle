// src/gov/federation.ts — W154 federation phase 1: hub policy distribution +
// spoke pull. GETs are anonymous spoke-pull reads in phase 1 (the manifest
// gets hub signatures in W156, so authenticity never rests on transport
// auth); presented credentials are always validated; POST requires
// buckle:spoke:WRITE_. Visibility law: spoke-private models never appear —
// structural (hub cannot see them) + defensive `visibility: spoke-private`.
import { Database } from "bun:sqlite";
import type { GatewayPolicy } from "../policy.ts";
import type { UpstreamPool } from "../upstreams.ts";
import { buildModels } from "./federation-entitlements.ts";
import {
	buildRules,
	crQueue,
	type FedManifest,
	manifestVersion,
	transitionCR,
} from "./federation-manifest.ts";
import { applyGovernanceSchema } from "./schema.ts";
import { authError, type Principal } from "./middleware.ts";

export interface FederationOpts {
	dbPath: string;
	policy: GatewayPolicy;
	pool: UpstreamPool;
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

export class Federation {
	readonly db: Database;
	private readonly policy: GatewayPolicy;
	private readonly pool: UpstreamPool;

	constructor(opts: FederationOpts) {
		this.db = new Database(opts.dbPath, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		applyGovernanceSchema(this.db);
		this.policy = opts.policy;
		this.pool = opts.pool;
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

	/** Route dispatch. CR delivery confirmation POST carries the spoke's
	 *  principal (gate enforces buckle:spoke:WRITE_; auth-off dev refuses
	 *  honestly when no principal ever got stashed). */
	async handle(req: Request, p: Principal | null): Promise<Response> {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname === "/federation/policy-manifest")
			return Response.json(this.manifest());
		if (req.method === "GET" && url.pathname === "/federation/entitlements")
			return Response.json(this.entitlements(p));
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
		const out = transitionCR(this.db, id, state, note);
		if (!out.ok) return bad(out.status, out.code, out.why);
		return Response.json({
			id,
			state: out.row.state,
			reported_at: out.row.reported_at,
		});
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
