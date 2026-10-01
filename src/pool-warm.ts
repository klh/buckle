// src/pool-warm.ts — the warm-rate gate (W143 speed §2): Bun's fetch already
// pools keep-alive sockets per origin (64-slot idle pool, oven-sh/bun#42608);
// what buckle adds is the observation seam and the boot pre-warm. A request
// observing an origin not marked warm has paid a connect — it counts a
// `pool_refill` event and marks the origin warm. Bun exposes no pool events,
// so cold is a heuristic: first use since boot/rebind, or first use after an
// origin re-appears (reload). The speed doc blesses exactly this heuristic
// (§6: idle-eviction timing unverified; shadow data will size it).
import type { UpstreamPool } from "./upstreams.ts";

export class PoolWarm {
	// origin → true once a response (or the pre-warm ping) established a
	// socket for it in this process
	private readonly warm = new Set<string>();
	private observes = 0;
	private refills = 0;
	// sink for the refill event (server.ts points it at servicemon; the bench
	// points it at its own collector)
	private sink: ((origin: string) => void) | null = null;

	setSink(sink: (origin: string) => void): void {
		this.sink = sink;
	}

	/** The request-path observation: counts the cold transition exactly once
	 *  per origin, then stays silent. Returns cold at the transition. */
	observe(origin: string): boolean {
		this.observes++;
		if (this.warm.has(origin)) return false;
		this.warm.add(origin);
		this.refills++;
		this.sink?.(origin);
		return true;
	}

	/** Mark warm WITHOUT counting a refill (the pre-warm ping path). */
	markWarm(origin: string): void {
		this.warm.add(origin);
	}

	isWarm(origin: string): boolean {
		return this.warm.has(origin);
	}

	/** warm-rate over observed upstream dispatches: 1 − refills/observes. */
	warmRate(): number | null {
		if (this.observes === 0) return null;
		return 1 - this.refills / this.observes;
	}

	stats(): { observes: number; refills: number; warmRate: number | null } {
		return {
			observes: this.observes,
			refills: this.refills,
			warmRate: this.warmRate(),
		};
	}

	/** Bench/test seam: forget every origin (the next observe is cold). */
	reset(): void {
		this.warm.clear();
		this.observes = 0;
		this.refills = 0;
	}
}

/** The process-wide tracker wire.ts's defaultFetch observes through. */
export const poolWarm = new PoolWarm();

/** Boot pre-warm: one GET /v1/models per deployment (the gateway-config.ts
 *  precedent), concurrent, never throws. Any response establishes the
 *  socket — even 401/404 — so the origin marks warm without a refill; a
 *  network-error origin stays cold and its first real request pays (and
 *  counts) the refill honestly. */
export async function prewarm(
	pool: UpstreamPool,
	fetchImpl: typeof fetch = fetch,
): Promise<{ warm: number; total: number; failed: string[] }> {
	const origins = new Set<string>();
	for (const group of pool.groups())
		for (const dep of pool.deployments(group)) origins.add(dep.url);
	const failed: string[] = [];
	let warm = 0;
	await Promise.all(
		[...origins].map(async (origin) => {
			try {
				await fetchImpl(`${origin.replace(/\/$/, "")}/v1/models`, {
					method: "GET",
					signal: AbortSignal.timeout(4000),
				});
				poolWarm.markWarm(origin);
				warm++;
			} catch {
				failed.push(origin);
			}
		}),
	);
	return { warm, total: origins.size, failed };
}
