// src/gov/middleware.ts — the W141 governance gate. One seam, enforced at
// startServer (Bun.serve) so the W133/W139/W140 handler tests that build
// createApp directly are untouched: bearer → authenticate → scope → budget
// → inner. Machine-readable 401/403/429 with stable `buckle.*` codes; every
// denial audits a route_audit row (denied audits too, W136 doctrine) and
// rejected authentications land in auth_events. PUBLIC routes: /health,
// /status, /metrics (service telemetry, not LLM ingress).
import { Database } from "bun:sqlite";
import {
	allowOf,
	options204,
	problem,
	type RateLimitView,
	stampRateLimit,
} from "../citizenship.ts";
import type { Ledger } from "../ledger.ts";
import type { Servicemon } from "../servicemon.ts";
import { Budgets, type BudgetView, effectiveLimit } from "./budgets.ts";
import { type Federation, stashPrincipal } from "./federation.ts";
import { createJwtValidator, type JwtOpts, jwtScopeCheck } from "./jwt.ts";
import { hashKey, KeyStore } from "./keys.ts";
import { applyGovernanceSchema } from "./schema.ts";
import { ALL_SCOPES, hasScope, scopesFromStorage } from "./scopes.ts";

export interface GovernanceOpts {
	dbPath: string;
	// break-glass bootstrap token (hashed by lookup, never stored)
	rootKey?: string;
	jwt?: JwtOpts;
	// W154: the shared Federation surface — the gate handles its auth
	// semantics (anonymous spoke-pull GETs, validated creds, spoke scope
	// for POST); serving itself lives on the app deps.
	federation?: Federation;
}

export interface Principal {
	kind: "root" | "api_key" | "jwt";
	keyId: string;
	team: string | null;
	actor: string | null;
	scopes: string[];
	jti: string | null;
	/** Key-carried budgets (null = unbounded at key level). */
	rpm: number | null;
	tpm: number | null;
}

export type AuthResult =
	| { ok: true; principal: Principal }
	| { ok: false; status: 401; code: string; why: string };

export interface GovernanceDeps {
	ledger: Ledger;
	sm: Servicemon;
}

export class Governance {
	readonly keys: KeyStore;
	readonly budgets: Budgets;
	readonly db: Database;
	private readonly sm: Servicemon;
	private readonly ledger: Ledger;
	private readonly jwtValidator: ReturnType<typeof createJwtValidator> | null;
	private readonly rootHash: string | null;
	/** W154: shared Federation surface (auth semantics at the gate; serving
	 *  itself lives on the app deps). */
	readonly federation: Federation | null;

	constructor(deps: GovernanceDeps, opts: GovernanceOpts) {
		this.sm = deps.sm;
		this.ledger = deps.ledger;
		// W154: adopt the shared Federation handle when present — one DB per
		// process, so :memory: tests and CR/team reads see one world.
		this.db =
			opts.federation?.db ?? new Database(opts.dbPath, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		applyGovernanceSchema(this.db);
		this.keys = new KeyStore(this.db);
		this.budgets = new Budgets(this.db);
		this.jwtValidator = opts.jwt ? createJwtValidator(opts.jwt) : null;
		this.rootHash = opts.rootKey ? hashKey(opts.rootKey) : null;
		this.federation = opts.federation ?? null;
	}

	/** Denial audit: route_audit row (denied audits too — W136) + counter. */
	auditDenial(p: {
		rid: string;
		actor: string;
		route: string;
		dialect: string;
		code: string;
		status: number;
		why: string;
	}): void {
		const ts = new Date().toISOString();
		this.ledger.auditDecision({
			rid: p.rid,
			ts,
			actor: p.actor,
			dialect: p.dialect,
			hint: "",
			candidates_seen: 0,
			candidates_top: "",
			target_kind: null,
			target_host: null,
			target_port: null,
			target_model: null,
			decision: "denied",
			latency_class: "unproven",
			tier: "",
			allow_cloud: false,
			error_code: p.code,
			why: p.why,
		});
		this.ledger.auditOutcome(p.rid, {
			status: p.status,
			duration_ms: 0,
			ok: false,
			err: p.why,
		});
		this.sm
			.counter("buckle_auth_decisions_total", "Governance gate decisions.")
			.inc({ decision: p.code, route: p.route });
	}

	/** Bearer token → Principal, or a stable machine-readable rejection.
	 *  Dispatch: root break-glass → api key (hash lookup) → JWT seam. */
	async authenticate(req: Request): Promise<AuthResult> {
		const header = req.headers.get("authorization") ?? "";
		const m = /^Bearer\s+(.+)$/i.exec(header);
		if (m === null)
			return {
				ok: false,
				status: 401,
				code: "buckle.auth_missing",
				why: "missing bearer token",
			};
		return this.authDispatch(m[1]?.trim() ?? "");
	}

	private async authDispatch(token: string): Promise<AuthResult> {
		if (token.length === 0)
			return {
				ok: false,
				status: 401,
				code: "buckle.auth_malformed",
				why: "empty bearer token",
			};
		if (this.rootHash !== null && hashKey(token) === this.rootHash) {
			return {
				ok: true,
				principal: {
					kind: "root",
					keyId: "root",
					team: null,
					actor: "root",
					scopes: [...ALL_SCOPES],
					jti: null,
					rpm: null,
					tpm: null,
				},
			};
		}
		return this.authByKeyKind(token);
	}

	private async authByKeyKind(token: string): Promise<AuthResult> {
		if (token.startsWith("bksk_")) {
			const v = this.keys.verify(token);
			if (!v.ok) return { ok: false, status: 401, code: v.code, why: v.why };
			const parsed = scopesFromStorage(v.key.scopes);
			return {
				ok: true,
				principal: {
					kind: "api_key",
					keyId: v.key.key_id,
					team: v.key.team,
					actor: v.key.actor,
					scopes: parsed.scopes,
					jti: v.key.jti,
					rpm: v.key.rpm_limit,
					tpm: v.key.tpm_limit,
				},
			};
		}
		return this.authJwt(token);
	}

	private async authJwt(token: string): Promise<AuthResult> {
		if (this.jwtValidator === null)
			return {
				ok: false,
				status: 401,
				code: "buckle.invalid_key",
				why: "unknown credential type",
			};
		const j = await this.jwtValidator.validate(token);
		if (!j.ok) return { ok: false, status: 401, code: j.code, why: j.why };
		return {
			ok: true,
			principal: {
				kind: "jwt",
				keyId: `jwt:${j.sub ?? "unknown"}`,
				team: null,
				actor: j.sub ?? null,
				scopes: j.scopes ?? [],
				jti: j.jti ?? null,
				rpm: null,
				tpm: null,
			},
		};
	}

	/** The request gate: classify → authenticate → authorize → budget →
	 *  inner. Every denial audits + rejects into auth_events. */
	gate(
		inner: (req: Request) => Response | Promise<Response>,
	): (req: Request) => Promise<Response> {
		return async (req: Request): Promise<Response> => {
			const path = new URL(req.url).pathname;
			// http-citizenship: introspection answers pre-auth from the one
			// route table — CORS preflights never carry credentials.
			if (req.method === "OPTIONS") {
				const allow = allowOf(path);
				if (allow !== null) return options204(allow);
			}
			const routeClass = classify(path);
			if (routeClass === "public") return inner(req);
			if (routeClass === "federation")
				return this.federationGate(req, path, inner);
			const t0 = Date.now();
			const rid = `g${t0.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
			const auth = await this.authenticate(req);
			if (!auth.ok) {
				this.rejectEvent(req, auth.code);
				this.auditDenial({
					rid,
					actor: actorOf(req),
					route: path,
					dialect: dialectOf(path),
					code: auth.code,
					status: auth.status,
					why: auth.why,
				});
				return authError(auth.status, auth.code, auth.why, { instance: path });
			}
			return this.authorize(
				req,
				path,
				routeClass,
				rid,
				auth.principal,
				t0,
				inner,
			);
		};
	}

	/** Federation semantics (W193): NO anonymous GETs — spoke authz at the
	 *  gate (GETs demand buckle:spoke:READ_); presented creds always
	 *  validated (invalid bearer = 401, never downgraded); POST needs
	 *  spoke:WRITE_; /federation/cr exact stays hub-admin. */
	private async federationGate(
		req: Request,
		path: string,
		inner: (req: Request) => Response | Promise<Response>,
	): Promise<Response> {
		if (this.federation === null) return inner(req);
		const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
		if (m === null)
			return authError(401, "buckle.auth_missing", "missing bearer token", {
				instance: path,
			});
		const auth = await this.authenticate(req);
		if (!auth.ok) {
			this.rejectEvent(req, auth.code);
			this.auditDenial({
				rid: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
				actor: actorOf(req),
				route: path,
				dialect: "federation",
				code: auth.code,
				status: auth.status,
				why: auth.why,
			});
			return authError(auth.status, auth.code, auth.why, { instance: path });
		}
		// W160 domain split at the gate: the CR-declare/list surface
		// (/federation/cr, exact) is HUB-ADMIN — spokes report status on
		// /federation/cr/:id/status and never hold the originate capability.
		const needed =
			path === "/federation/cr"
				? scopeNeeded("admin", req.method)
				: scopeNeeded("spoke", req.method);
		if (!hasScope(auth.principal.scopes, needed))
			return authError(403, "buckle.insufficient_scope", `requires ${needed}`);
		stashPrincipal(req, auth.principal);
		return inner(req);
	}

	/** auth_events rejected row keyed by the presented credential hint. */
	private rejectEvent(req: Request, code: string): void {
		void code;
		this.keys.recordAuthEvent(actorOf(req), "rejected", null, "api_key");
	}

	private async authorize(
		req: Request,
		path: string,
		routeClass: "proxy" | "admin",
		rid: string,
		p: Principal,
		t0: number,
		inner: (req: Request) => Response | Promise<Response>,
	): Promise<Response> {
		const needed = scopeNeeded(routeClass, req.method);
		const enough =
			p.kind === "jwt"
				? jwtScopeCheck(p.scopes, needed)
				: hasScope(p.scopes, needed);
		if (!enough) {
			return this.denied({
				req,
				path,
				rid,
				p,
				status: 403,
				code: "buckle.insufficient_scope",
				why: `requires ${needed}`,
				t0,
				inner,
			});
		}
		if (routeClass === "admin") {
			const admin = await import("./admin.ts");
			return admin.handleAdmin(req, p, this);
		}
		return this.budget(req, path, rid, p, t0, inner);
	}

	/** Budget admission for the proxy class: effective limits = min(key,
	 *  team ceiling); 429 with retry-after (remainder + jitter). */
	private budget(
		req: Request,
		path: string,
		rid: string,
		p: Principal,
		t0: number,
		inner: (req: Request) => Response | Promise<Response>,
	): Response | Promise<Response> {
		void rid;
		void t0;
		const ceiling = p.team !== null ? this.keys.teamCeilings(p.team) : null;
		const limits = effectiveLimit({ rpm: p.rpm, tpm: p.tpm }, ceiling);
		return this.admit(req, path, rid, p, limits, inner);
	}

	private async admit(
		req: Request,
		path: string,
		rid: string,
		p: Principal,
		limits: { rpm: number | null; tpm: number | null },
		inner: (req: Request) => Response | Promise<Response>,
	): Promise<Response> {
		if (limits.rpm === null && limits.tpm === null) return inner(req);
		const chk = this.budgets.check(
			p.keyId,
			limits,
			Number(req.headers.get("content-length") ?? "0"),
		);
		const view = this.rateView(limits, chk.view);
		if (!chk.ok) return this.rateLimited(path, rid, p, view, chk.retryAfterS);
		const resp = await inner(req);
		// http-citizenship: the trio rides every budgeted response.
		if (view !== null) stampRateLimit(resp.headers, view);
		return resp;
	}

	/** The trio basis: rpm when bounded, else tpm. Unbounded principals get
	 *  honest omission — the gate never invents numbers it does not enforce. */
	private rateView(
		limits: { rpm: number | null; tpm: number | null },
		v: BudgetView,
	): RateLimitView | null {
		if (limits.rpm !== null)
			return {
				limit: limits.rpm,
				remaining: limits.rpm - v.usedReqs,
				resetS: v.resetS,
				resetEpochS: v.resetEpochS,
				policy: `rpm;q=${String(limits.rpm)}`,
			};
		if (limits.tpm !== null)
			return {
				limit: limits.tpm,
				remaining: limits.tpm - v.usedTks,
				resetS: v.resetS,
				resetEpochS: v.resetEpochS,
				policy: `tpm;q=${String(limits.tpm)}`,
			};
		return null;
	}

	/** 429: Retry-After + zeroed trio in both families; audit + counter. */
	private rateLimited(
		path: string,
		rid: string,
		p: Principal,
		view: RateLimitView | null,
		retryAfterS: number,
	): Response {
		this.auditDenial({
			rid,
			actor: p.keyId,
			route: path,
			dialect: dialectOf(path),
			code: "buckle.rate_limited",
			status: 429,
			why: "budget exceeded",
		});
		const resp = authError(429, "buckle.rate_limited", "budget exceeded", {
			instance: path,
			headers: { "retry-after": String(Math.ceil(retryAfterS)) },
		});
		if (view !== null) stampRateLimit(resp.headers, { ...view, remaining: 0 });
		return resp;
	}

	/** Scope-denied (403): audit row + fixed envelope. */
	private denied(p: {
		req: Request;
		path: string;
		rid: string;
		p: Principal;
		status: 401 | 403;
		code: string;
		why: string;
		t0: number;
		inner: (req: Request) => Response | Promise<Response>;
	}): Response {
		void p.req;
		void p.t0;
		void p.inner;
		this.auditDenial({
			rid: p.rid,
			actor: p.p.keyId,
			route: p.path,
			dialect: dialectOf(p.path),
			code: p.code,
			status: p.status,
			why: p.why,
		});
		return authError(p.status, p.code, p.why, { instance: p.path });
	}
}

const REALM = 'Bearer realm="buckle"';

/** The WWW-Authenticate challenge per denial class (RFC 6750 §3): missing
 *  credentials get a bare Bearer challenge; presented-but-invalid get
 *  error="invalid_token"; scope denials get error="insufficient_scope". */
function challengeFor(
	status: 401 | 403 | 429,
	code: string,
): string | undefined {
	if (status === 401)
		return code === "buckle.auth_missing"
			? REALM
			: `${REALM}, error="invalid_token"`;
	if (status === 403) return `${REALM}, error="insufficient_scope"`;
	return undefined;
}

/** Machine-actionable recovery per denial class (agent_next_steps). */
const AUTH_NEXT: Record<401 | 403 | 429, string[]> = {
	401: [
		"retry with a valid bearer token",
		"mint a key: POST /v1/admin/keys (needs buckle:admin:WRITE_)",
	],
	403: ["re-mint the key with the scope named in why"],
	429: [
		"wait Retry-After seconds before the next dispatch",
		"budgets reset each minute window (RateLimit-Reset)",
	],
};

/** Fixed-shape auth failure envelope — problem+json, stable codes. */
export function authError(
	status: 401 | 403 | 429,
	code: string,
	message: string,
	opts?: { instance?: string; headers?: Record<string, string> },
): Response {
	return problem({
		status,
		code,
		why: message,
		instance: opts?.instance,
		next: AUTH_NEXT[status],
		challenge: challengeFor(status, code),
		headers: opts?.headers,
	});
}

/** Route classes at the gate: public telemetry, admin API, spoke-pull
 *  federation, LLM proxy. Federation paths get deliberate handling — they
 *  are NOT anonymous proxy-class 401s anymore (W154). */
export function classify(
	path: string,
): "public" | "admin" | "proxy" | "federation" {
	if (path === "/health" || path === "/status" || path === "/metrics")
		return "public";
	if (path === "/.well-known/jwks.json") return "public"; // W193 JWKS: spokes fetch pre-cred
	if (path === "/federation" || path.startsWith("/federation/"))
		return "federation";
	if (path.startsWith("/v1/admin")) return "admin";
	return "proxy";
}

/** Scope requirement per route class + method (READ_ for GET, WRITE_ else). */
export function scopeNeeded(
	routeClass: "admin" | "proxy" | "spoke",
	method: string,
): string {
	const role = method === "GET" ? "READ_" : "WRITE_";
	return `buckle:${routeClass}:${role}`;
}

function dialectOf(path: string): string {
	return path.startsWith("/v1/messages") ? "anthropic" : "openai";
}

function actorOf(req: Request): string {
	const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
	if (m === null) return "anonymous";
	return hashKey(m[1]?.trim() ?? "").slice(0, 12);
}

/** Build the gate over the app deps (ledger + servicemon) + opts. */
export function createGovernance(
	deps: GovernanceDeps,
	opts: GovernanceOpts,
): Governance {
	return new Governance(deps, opts);
}
