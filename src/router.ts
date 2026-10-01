// src/router.ts — ladder walk + retry + cooldown. Semantics ported from the
// MIT-licensed LiteLLM 1.103.0 core (router.py + router_utils/, pinned-source
// verified W129): ordered cross-group fallback after per-tier retries
// (num_retries), passive outlier ejection (allowed_fails consecutive
// failures → benched for cooldown_time seconds, reset on success), and
// retry-after-honoring backoff with jitter (utils.py::_calculate_retry_after
// semantics: upstream retry-after verbatim when present, capped exponential
// 2**attempt + U[0,1) jitter when absent). Owner directive enforced
// structurally: flashx tiers are refused in every ladder walk.
import { Cooldowns, retryAfterS, retryDelayS } from "./cooldown.ts";
import type { GatewayPolicy } from "./policy.ts";
import type { Dialect, Deployment, UpstreamPool } from "./upstreams.ts";

export const FLASHX = /flashx/i;

export type ExecuteResult =
	| {
			kind: "upstream";
			response: Response;
			deployment: Deployment;
			tier: string;
			attempts: number;
			stream: boolean;
	  }
	| {
			kind: "client-error";
			response: Response;
			tier: string;
			attempts: number;
	  }
	| {
			kind: "aborted";
	  }
	| {
			kind: "exhausted";
			status: number;
			error: string;
			attempts: number;
	  };

export interface UpstreamRequest {
	group: string;
	dialect: Dialect;
	path: string;
	body: Record<string, unknown>;
	key: string;
	signal?: AbortSignal;
}

export interface RouterMetrics {
	fallback(tier: string): void;
	cooldown(dep: string): void;
	refused(tier: string): void;
}

/** A single upstream attempt's classified outcome. */
export type TryOutcome =
	| { ok: true; response: Response }
	| {
			ok: false;
			response: Response;
			status: number;
			error: string;
			retryAfterS: number | null;
			clientFault: boolean;
			exhaustTier: boolean;
	  };

/** Thrown when an upstream is unreachable (network/timeout); the walk
 *  catches it and keeps going (ladder), rethrows on caller abort. */
export class UpstreamError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export interface RouterDeps {
	pool: UpstreamPool;
	now?: () => number;
	rng?: () => number;
	sleepMs?: (ms: number) => Promise<void>;
	fetchImpl?: (
		dep: Deployment,
		req: UpstreamRequest,
		timeoutMs: number,
	) => Promise<Response>;
	metrics?: RouterMetrics;
}

export class Router {
	private readonly cooldowns: Cooldowns;
	private readonly now: () => number;
	private readonly rng: () => number;
	private readonly sleepMs: (ms: number) => Promise<void>;
	private readonly fetchImpl: (
		dep: Deployment,
		req: UpstreamRequest,
		timeoutMs: number,
	) => Promise<Response>;
	private readonly metrics?: RouterMetrics;

	constructor(
		private readonly policy: GatewayPolicy,
		private readonly deps: RouterDeps,
	) {
		this.cooldowns = new Cooldowns(
			policy.allowed_fails ?? 3,
			policy.cooldown_time ?? 30,
			deps.now,
		);
		this.now = deps.now ?? Date.now;
		this.rng = deps.rng ?? Math.random;
		this.sleepMs =
			deps.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
		this.fetchImpl = deps.fetchImpl ?? defaultFetchImpl;
	}

	private tierCandidates(tier: string, req: UpstreamRequest): Deployment[] {
		return this.deps.pool
			.deployments(tier)
			.filter((d) => d.dialect === req.dialect && !this.cooldowns.benched(d));
	}

	/** One upstream attempt, outcome classified for the walk. */
	private async tryOnce(
		req: UpstreamRequest,
		dep: Deployment,
		timeoutMs: number,
	): Promise<TryOutcome> {
		try {
			const resp = await this.fetchImpl(dep, req, timeoutMs);
			if (resp.ok) {
				this.cooldowns.success(dep);
				return { ok: true, response: resp };
			}
			const ra = retryAfterS(resp.headers, this.now);
			const bad400 =
				resp.status === 400 || resp.status === 413 || resp.status === 422;
			if (bad400) {
				return {
					ok: false,
					response: resp,
					status: resp.status,
					error: `upstream rejected the request (${String(resp.status)})`,
					retryAfterS: ra,
					clientFault: true,
					exhaustTier: false,
				};
			}
			resp.body?.cancel().catch(() => {});
			this.cooldowns.failure(dep);
			this.metrics?.cooldown(`${dep.group}|${dep.url}`);
			const authish =
				resp.status === 401 || resp.status === 403 || resp.status === 404;
			return {
				ok: false,
				response: resp,
				status: resp.status,
				error: `upstream ${dep.url} returned ${String(resp.status)}`,
				retryAfterS: ra,
				clientFault: false,
				exhaustTier: authish,
			};
		} catch (e) {
			if (req.signal?.aborted) throw e;
			this.cooldowns.failure(dep);
			this.metrics?.cooldown(`${dep.group}|${dep.url}`);
			throw new UpstreamError(502, `upstream ${dep.url} unreachable`);
		}
	}

	/** Same-tier retry loop (num_retries + 1 attempts across candidates). */
	private async attemptTier(
		req: UpstreamRequest,
		tier: string,
		candidates: Deployment[],
		st: { attempts: number; status: number; error: string },
	): Promise<ExecuteResult | null> {
		const retries = this.policy.num_retries ?? 1;
		const capS = this.policy.retry_max_delay_s ?? 8;
		const timeoutMs = (this.policy.request_timeout_s ?? 120) * 1000;
		for (let attempt = 0; attempt <= retries; attempt++) {
			if (req.signal?.aborted) return { kind: "aborted" };
			const dep = candidates.at(Math.min(attempt, candidates.length - 1));
			if (!dep) break;
			st.attempts++;
			const r = await this.tryOnce(req, dep, timeoutMs);
			if (r.ok) {
				return {
					kind: "upstream",
					response: r.response,
					deployment: dep,
					tier,
					attempts: st.attempts,
					stream: req.body.stream === true,
				};
			}
			st.status = r.status;
			st.error = r.error;
			if (r.clientFault) {
				return {
					kind: "client-error",
					response: r.response,
					tier,
					attempts: st.attempts,
				};
			}
			if (r.exhaustTier) break;
			await this.sleepMs(
				retryDelayS(attempt, r.retryAfterS, this.rng, capS) * 1000,
			);
		}
		return null;
	}

	/** Ladder walk: requested group first, then the policy fallback list.
	 *  flashx tiers are refused (owner directive); dormant groups (zero
	 *  matching deployments — e.g. cloud tiers with no BUCKLE_UPSTREAMS
	 *  override) are skipped as skip-not-failure. */
	async execute(req: UpstreamRequest): Promise<ExecuteResult> {
		if (req.signal?.aborted) return { kind: "aborted" };
		const st = {
			attempts: 0,
			status: 502,
			error: `no healthy upstream for ${req.group}`,
		};
		const tiers = [req.group, ...(this.policy.fallbacks?.[req.group] ?? [])];
		for (const tier of tiers) {
			if (FLASHX.test(tier)) {
				this.metrics?.refused(tier);
				continue;
			}
			const candidates = this.tierCandidates(tier, req);
			if (candidates.length === 0) continue;
			if (tier !== req.group) this.metrics?.fallback(tier);
			const r = await this.attemptTier(req, tier, candidates, st);
			if (r !== null) return r;
		}
		return { kind: "exhausted", ...st };
	}
}

async function defaultFetchImpl(
	dep: Deployment,
	req: UpstreamRequest,
	timeoutMs: number,
): Promise<Response> {
	const { defaultFetch } = await import("./wire.ts");
	return defaultFetch(dep, req, timeoutMs);
}
