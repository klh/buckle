// test/router-ladder.test.ts — ladder walk order, never-flashx, dormant
// tiers (mock upstreams — no network in these).
import { describe, expect, test } from "bun:test";
import type { GatewayPolicy } from "../src/policy.ts";
import { Router } from "../src/router.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

const POLICY: GatewayPolicy = {
	num_retries: 1,
	allowed_fails: 3,
	cooldown_time: 30,
	fallbacks: { "glm-5.3-flash": ["local-swarm", "gpt-5.2", "claude-sonnet-5"] },
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

function makeRouter(
	pool: UpstreamPool,
	fetchImpl: (url: string) => Promise<Response>,
) {
	const attempted: string[] = [];
	const slept: number[] = [];
	const router = new Router(POLICY, {
		pool,
		rng: () => 0,
		sleepMs: async (ms) => {
			slept.push(ms);
		},
		fetchImpl: async (d) => {
			attempted.push(`${d.group}|${d.url}`);
			return fetchImpl(`${d.group}|${d.url}`);
		},
	});
	return { router, attempted, slept };
}

const OK = (): Response => Response.json({ ok: true });
const FAIL = (): Response => Response.json({ e: 1 }, { status: 500 });

describe("ladder walk", () => {
	const req = () => ({
		group: "glm-5.3-flash",
		dialect: "openai" as const,
		path: "/v1/chat/completions",
		body: { model: "glm-5.3-flash", stream: false },
		key: "",
	});

	test("walks the W124 ladder in order after retries", async () => {
		const { router, attempted } = makeRouter(
			poolOf([
				["glm-5.3-flash", ["http://flash"]],
				["local-swarm", ["http://swarm"]],
				["gpt-5.2", ["http://gpt"]],
			]),
			(url) =>
				url.includes("gpt") ? Promise.resolve(OK()) : Promise.resolve(FAIL()),
		);
		const r = await router.execute(req());
		expect(r.kind).toBe("upstream");
		if (r.kind === "upstream") expect(r.tier).toBe("gpt-5.2");
		// flash 2 attempts (1+num_retries), swarm 2, gpt 1 → 5
		expect(attempted).toEqual([
			"glm-5.3-flash|http://flash",
			"glm-5.3-flash|http://flash",
			"local-swarm|http://swarm",
			"local-swarm|http://swarm",
			"gpt-5.2|http://gpt",
		]);
	});

	test("NEVER flashx: refused even when configured in the ladder", async () => {
		const attemptedFlashx: boolean[] = [];
		const policy = {
			...POLICY,
			fallbacks: { "glm-5.3-flash": ["glm-5.3-flashx", "gpt-5.2"] },
		};
		const router = new Router(policy, {
			pool: poolOf([
				["glm-5.3-flash", ["http://flash"]],
				["glm-5.3-flashx", ["http://flashx"]],
				["gpt-5.2", ["http://gpt"]],
			]),
			rng: () => 0,
			sleepMs: async () => {},
			fetchImpl: async (d) => {
				attemptedFlashx.push(d.url.includes("flashx"));
				return d.url.includes("gpt") ? OK() : FAIL();
			},
		});
		const r = await router.execute(req());
		expect(r.kind).toBe("upstream");
		if (r.kind === "upstream") expect(r.tier).toBe("gpt-5.2");
		expect(attemptedFlashx.every((x) => !x)).toBe(true);
	});

	test("dormant tier (no deployments) is a skip, not a failure", async () => {
		const { router, attempted } = makeRouter(
			poolOf([
				["glm-5.3-flash", ["http://flash"]],
				["cloud-tier", []],
				["gpt-5.2", ["http://gpt"]],
			]),
			(url) =>
				url.includes("gpt") ? Promise.resolve(OK()) : Promise.resolve(FAIL()),
		);
		const r = await router.execute(req());
		expect(r.kind).toBe("upstream");
		if (r.kind === "upstream") expect(r.tier).toBe("gpt-5.2");
		expect(attempted.every((u) => !u.includes("cloud-tier"))).toBe(true);
	});
});
