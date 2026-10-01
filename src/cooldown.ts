// src/cooldown.ts — the two ported LiteLLM primitives the ladder needs:
// retry-after-aware backoff (utils.py::_calculate_retry_after semantics:
// upstream retry-after verbatim — both delta-seconds and HTTP-date forms —
// capped exponential 2**attempt + U[0,1) jitter when absent) and passive
// outlier ejection (allowed_fails consecutive failures bench a deployment
// for cooldown_time seconds; success resets the counter — cooldown_cache /
// cooldown_handlers semantics at fixed-policy scale).
import type { Deployment } from "./upstreams.ts";

/** Backoff delay in seconds before the next same-tier attempt. */
export function retryDelayS(
	attempt: number,
	retryAfter: number | null,
	rng: () => number,
	capS: number,
): number {
	if (retryAfter !== null) return retryAfter + rng();
	return Math.min(2 ** attempt, capS) + rng();
}

/** retry-after header value in delta seconds, honoring both forms LiteLLM
 *  accepts: delta-seconds and HTTP-date form. */
export function retryAfterS(
	h: Headers,
	now: () => number = Date.now,
): number | null {
	const raw = h.get("retry-after");
	if (raw === null) return null;
	const delta = Number(raw);
	if (Number.isFinite(delta)) return Math.max(0, delta);
	const at = Date.parse(raw);
	if (Number.isFinite(at)) return Math.max(0, (at - now()) / 1000);
	return null;
}

/** Consecutive-failure ejection state (allowed_fails: consecutive failures
 *  bench a deployment for the cooldown window; success resets). */
export class Cooldowns {
	private readonly fails = new Map<string, number>();
	private readonly until = new Map<string, number>();

	constructor(
		private readonly allowedFails: number,
		private readonly cooldownS: number,
		private readonly now: () => number = Date.now,
	) {}

	private static key(dep: Deployment): string {
		return `${dep.group}|${dep.url}`;
	}

	failure(dep: Deployment): void {
		const k = Cooldowns.key(dep);
		const n = (this.fails.get(k) ?? 0) + 1;
		this.fails.set(k, n);
		if (n >= this.allowedFails) {
			this.until.set(k, this.now() + this.cooldownS * 1000);
			this.fails.set(k, 0);
		}
	}

	success(dep: Deployment): void {
		this.fails.set(Cooldowns.key(dep), 0);
	}

	benched(dep: Deployment): boolean {
		const until = this.until.get(Cooldowns.key(dep));
		if (until === undefined) return false;
		if (until <= this.now()) {
			this.until.delete(Cooldowns.key(dep));
			return false;
		}
		return true;
	}
}
