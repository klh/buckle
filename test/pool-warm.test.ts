// test/pool-warm.test.ts — the warm-rate gate: cold transitions count
// exactly one pool_refill per origin, the pre-warm marks warm without
// counting, and warm-rate math is honest.
import { describe, expect, test } from "bun:test";
import { PoolWarm, prewarm, poolWarm } from "../src/pool-warm.ts";
import { startMockUpstream } from "./mock.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

describe("PoolWarm", () => {
	test("first observe is cold, then warm; rate math", () => {
		const p = new PoolWarm();
		expect(p.observe("o1")).toBe(true);
		expect(p.observe("o1")).toBe(false);
		expect(p.observe("o2")).toBe(true);
		const s = p.stats();
		expect(s.observes).toBe(3);
		expect(s.refills).toBe(2);
		expect(s.warmRate).toBeCloseTo(1 / 3);
	});

	test("markWarm does not count a refill", () => {
		const p = new PoolWarm();
		p.markWarm("o1");
		expect(p.observe("o1")).toBe(false);
		expect(p.stats().refills).toBe(0);
	});

	test("sink fires once per cold transition", () => {
		const p = new PoolWarm();
		const seen: string[] = [];
		p.setSink((o) => seen.push(o));
		p.observe("a");
		p.observe("a");
		expect(seen).toEqual(["a"]);
	});

	test("reset makes the next observe cold again", () => {
		const p = new PoolWarm();
		p.markWarm("a");
		p.reset();
		expect(p.observe("a")).toBe(true);
	});

	test("prewarm pings each origin once and marks warm without refills", async () => {
		const up = await startMockUpstream(() =>
			Response.json({ object: "list", data: [] }),
		);
		const pool: UpstreamPool = {
			groups: () => ["g"],
			deployments: () => [{ group: "g", url: up.url, dialect: "openai" }],
		};
		// prewarm marks the module singleton warm without counting refills
		const res = await prewarm(pool);
		expect(res.warm).toBe(1);
		expect(res.total).toBe(1);
		expect(res.failed).toEqual([]);
		expect(poolWarm.isWarm(up.url)).toBe(true);
		expect(poolWarm.stats().refills).toBe(0);
		up.close();
	});
});
