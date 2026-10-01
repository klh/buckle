// test/router-retry.test.ts — retry-after honored + cooldown ejection in
// the walk (mock upstreams, immediate sleeps, deterministic rng).
import { describe, expect, test } from "bun:test";
import type { GatewayPolicy } from "../src/policy.ts";
import { Router } from "../src/router.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

const POLICY: GatewayPolicy = {
	num_retries: 1,
	allowed_fails: 3,
	cooldown_time: 30,
};

function poolOf(entries: Array<[string, string[]]>): UpstreamPool {
	const map = new Map(entries);
	return {
		groups: () => [...map.keys()],
		deployments: (g) =>
			(map.get(g) ?? []).map((url) => ({
				group: g,
				url,
				dialect: "openai" as const,
			})),
	};
}

describe("retry + cooldown in the walk", () => {
	test("upstream retry-after is honored before the same-tier retry", async () => {
		let calls = 0;
		const slept: number[] = [];
		const policy = { ...POLICY, num_retries: 1 };
		const pool = poolOf([["g", ["http://only"]]]);
		const router = new Router(policy, {
			pool,
			rng: () => 0,
			sleepMs: async (ms) => {
				slept.push(ms);
			},
			fetchImpl: async () => {
				calls++;
				if (calls === 1) {
					return Response.json(
						{ e: 1 },
						{ status: 429, headers: { "retry-after": "0.05" } },
					);
				}
				return Response.json({ ok: true });
			},
		});
		const r = await router.execute({
			group: "g",
			dialect: "openai",
			path: "/v1/chat/completions",
			body: { model: "g", stream: false },
			key: "",
		});
		expect(r.kind).toBe("upstream");
		expect(calls).toBe(2);
		expect(slept).toEqual([50]); // retry-after 0.05s honored, jitter 0
	});

	test("allowed_fails consecutive failures eject the deployment", async () => {
		let calls = 0;
		const policy = { ...POLICY, allowed_fails: 2 };
		const router = new Router(policy, {
			pool: poolOf([["g", ["http://only"]]]),
			rng: () => 0,
			sleepMs: async () => {},
			fetchImpl: async () => {
				calls++;
				return Response.json({ e: 1 }, { status: 500 });
			},
		});
		const req = {
			group: "g",
			dialect: "openai" as const,
			path: "/v1/chat/completions",
			body: { model: "g", stream: false },
			key: "",
		};
		const r1 = await router.execute(req);
		expect(r1.kind).toBe("exhausted");
		expect(calls).toBe(2); // 1 + num_retries
		const r2 = await router.execute(req);
		expect(r2.kind).toBe("exhausted");
		expect(calls).toBe(2); // benched — no new upstream calls
	});

	test("cooldown recovery: deployment retried after the window", async () => {
		let calls = 0;
		let t = 1000;
		const policy = { ...POLICY, allowed_fails: 2, cooldown_time: 30 };
		const router = new Router(policy, {
			pool: poolOf([["g", ["http://only"]]]),
			now: () => t,
			rng: () => 0,
			sleepMs: async () => {},
			fetchImpl: async () => {
				calls++;
				return calls <= 2
					? Response.json({ e: 1 }, { status: 500 })
					: Response.json({ ok: true });
			},
		});
		const req = {
			group: "g",
			dialect: "openai" as const,
			path: "/v1/chat/completions",
			body: { model: "g", stream: false },
			key: "",
		};
		expect((await router.execute(req)).kind).toBe("exhausted");
		t += 30_000;
		expect((await router.execute(req)).kind).toBe("upstream");
	});
});
