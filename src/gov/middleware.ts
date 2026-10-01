// src/gov/middleware.ts — the W141 governance gate. One seam, enforced at
// startServer (Bun.serve) so the W133/W139/W140 handler tests that build
// createApp directly are untouched: bearer → authenticate → scope → budget
// → inner. Machine-readable 401/403/429 with stable `buckle.*` codes; every
// denial audits a route_audit row (denied audits too, W136 doctrine) and
// rejected authentications land in auth_events. PUBLIC routes: /health,
// /status, /metrics (service telemetry, not LLM ingress).
import { Database } from "bun:sqlite";
import { Budgets, effectiveLimit } from "./budgets.ts";
import { KeyStore, hashKey } from "./keys.ts";
import { createJwtValidator, type JwtOpts, jwtScopeCheck } from "./jwt.ts";
import { applyGovernanceSchema } from "./schema.ts";
import { ALL_SCOPES, hasScope, scopesFromStorage } from "./scopes.ts";
import type { Ledger } from "../ledger.ts";
import type { Servicemon } from "../servicemon.ts";

export interface GovernanceOpts {
	dbPath: string;
	// break-glass bootstrap token (hashed by lookup, never stored)
	rootKey?: string;
	jwt?: JwtOpts;
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

export const AUTH_ERROR_TYPES: Record<string, string> = {
	401: "authentication_error",
	403: "permission_error",
	429: "rate_limit_error",
};

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

	constructor(deps: GovernanceDeps, opts: GovernanceOpts) {
		this.sm = deps.sm;
		this.ledger = deps.ledger;
		this.db = new Database(opts.dbPath, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		applyGovernanceSchema(this.db);
		this.keys = new KeyStore(this.db);
		this.budgets = new Budgets(this.db);
		this.jwtValidator = opts.jwt ? createJwtValidator(opts.jwt) : null;
		this.rootHash = opts.rootKey ? hashKey(opts.rootKey) : null;
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
			const routeClass = classify(path);
			if (routeClass === "public") return inner(req);
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
				return authError(auth.status, auth.code, auth.why);
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

	private admit(
		req: Request,
		path: string,
		rid: string,
		p: Principal,
		limits: { rpm: number | null; tpm: number | null },
		inner: (req: Request) => Response | Promise<Response>,
	): Response | Promise<Response> {
		if (limits.rpm !== null || limits.tpm !== null) {
			const chk = this.budgets.check(
				p.keyId,
				limits,
				Number(req.headers.get("content-length") ?? "0"),
			);
			if (!chk.ok) return this.rateLimited(path, rid, p, chk.retryAfterS);
		}
		return inner(req);
	}

	/** 429 with retry-after; audit + counter. */
	private rateLimited(
		path: string,
		rid: string,
		p: Principal,
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
		const resp = authError(429, "buckle.rate_limited", "budget exceeded");
		resp.headers.set("retry-after", String(Math.ceil(retryAfterS)));
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
		return authError(p.status, p.code, p.why);
	}
}

/** Fixed-shape auth failure envelope — stable codes, never silent. */
export function authError(
	status: 401 | 403 | 429,
	code: string,
	message: string,
): Response {
	return Response.json(
		{
			error: {
				type: AUTH_ERROR_TYPES[String(status)],
				code,
				message,
			},
		},
		{
			status,
			headers:
				status === 401
					? { "www-authenticate": "Bearer" }
					: status === 429
						? {}
						: {},
		},
	);
}

/** Route classes at the gate: public telemetry, admin API, LLM proxy. */
export function classify(path: string): "public" | "admin" | "proxy" {
	if (path === "/health" || path === "/status" || path === "/metrics")
		return "public";
	if (path.startsWith("/v1/admin")) return "admin";
	return "proxy";
}

/** Scope requirement per route class + method (READ_ for GET, WRITE_ else). */
export function scopeNeeded(
	routeClass: "admin" | "proxy",
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
