// test/deps.ts — full AppDeps over a mock pool: candidate table + pure
// decide + router sharing one Cooldowns instance (the W140 seam,
// server-shaped). e2e tests build deps through here.
import { CandidateTable } from "../src/candidates.ts";
import { Cooldowns } from "../src/cooldown.ts";
import { decideRoute } from "../src/decide.ts";
import type { RouteHint } from "../src/hints.ts";
import type { AppDeps } from "../src/handlers.ts";
import { Ledger } from "../src/ledger.ts";
import type { GatewayPolicy, Prefs } from "../src/policy.ts";
import { Router } from "../src/router.ts";
import { servicemon } from "../src/servicemon.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

export function testDeps(
	pool: UpstreamPool,
	opts?: {
		policy?: GatewayPolicy;
		prefs?: Prefs;
		sleepMs?: (ms: number) => Promise<void>;
	},
): AppDeps {
	const policy: GatewayPolicy = opts?.policy ?? {
		num_retries: 1,
		allowed_fails: 3,
		cooldown_time: 30,
	};
	const cooldowns = new Cooldowns(
		policy.allowed_fails ?? 3,
		policy.cooldown_time ?? 30,
	);
	const table = new CandidateTable({ pool, policy, cooldowns });
	const router = new Router(policy, {
		pool,
		cooldowns,
		sleepMs: opts?.sleepMs,
	});
	const prefs: Prefs = opts?.prefs ?? {
		cost_speed: "balanced",
		allow_cloud: false,
	};
	const decide = (input: {
		group: string;
		dialect: "openai" | "anthropic";
		hint: RouteHint | null;
		hintRaw: string;
	}) => decideRoute({ ...input, candidates: table.snapshot(), prefs });
	return {
		router,
		ledger: new Ledger(":memory:"),
		sm: servicemon({ service: "buckle-test", port: 0 }),
		pool,
		decide,
		table,
	};
}
