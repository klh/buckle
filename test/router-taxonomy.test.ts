// test/router-taxonomy.test.ts — review #14 §1.3: Router.tryOnce classifies
// through the adapters/errors.ts normalizer (status + body signature +
// body retry-after), so context-window and body-level errors fail over.
import { describe, expect, test } from "bun:test";
import type { GatewayPolicy } from "../src/policy.ts";
import { Router } from "../src/router.ts";
import type { Dialect, UpstreamPool } from "../src/upstreams.ts";

const POLICY: GatewayPolicy = {
	num_retries: 1,
	allowed_fails: 3,
	cooldown_time: 30,
	fallbacks: { small: ["big"] },
};

function poolOf(
	entries: Array<[string, string[]]>,
	dialect: Dialect = "openai",
): UpstreamPool {
	const map = new Map(entries);
	return {
		groups: () => [...map.keys()],
		deployments: (g) =>
			(map.get(g) ?? []).map((url) => ({ group: g, url, dialect })),
	};
}

function harness(
	reply: (url: string, n: number) => Response,
	dialect: Dialect = "openai",
) {
	const attempted: string[] = [];
	const slept: number[] = [];
	const router = new Router(POLICY, {
		pool: poolOf(
			[
				["small", ["http://small"]],
				["big", ["http://big"]],
			],
			dialect,
		),
		rng: () => 0,
		sleepMs: async (ms) => {
			slept.push(ms);
		},
		fetchImpl: async (dep) => {
			attempted.push(dep.url);
			return reply(dep.url, attempted.length);
		},
	});
	const run = () =>
		router.execute({
			group: "small",
			dialect,
			path: dialect === "openai" ? "/v1/chat/completions" : "/v1/messages",
			body: { model: "small", stream: false },
			key: "",
		});
	return { router, attempted, slept, run };
}

const CTX = () =>
	Response.json(
		{
			error: {
				message: "This model's maximum context length is 8192 tokens",
				code: "context_length_exceeded",
			},
		},
		{ status: 400 },
	);

describe("error taxonomy in the walk", () => {
	test("context-window 400 fails over to the next rung (no client-error)", async () => {
		const h = harness((url) =>
			url === "http://small" ? CTX() : Response.json({ ok: 1 }),
		);
		const r = await h.run();
		expect(r.kind).toBe("upstream");
		expect(h.attempted).toEqual(["http://small", "http://big"]);
		expect(h.slept).toEqual([]); // tier exhausted at once, no backoff
	});

	test("context-window on every rung → the upstream 400, not a 502", async () => {
		const h = harness(() => CTX());
		const r = await h.run();
		expect(r.kind).toBe("client-error");
		if (r.kind !== "client-error") return;
		expect(r.response.status).toBe(400);
		const body = (await r.response.json()) as { error: { code: string } };
		expect(body.error.code).toBe("context_length_exceeded");
	});

	test("context-window never benches the deployment", async () => {
		const h = harness(() => CTX());
		for (let i = 0; i < 5; i++) await h.run();
		// allowed_fails=3: a benched deployment would vanish from the walk
		h.attempted.length = 0;
		await h.run();
		expect(h.attempted).toEqual(["http://small", "http://big"]);
	});

	test("plain bad_request stays a client error (no failover)", async () => {
		const h = harness(() =>
			Response.json({ error: { message: "bad temperature" } }, { status: 400 }),
		);
		const r = await h.run();
		expect(r.kind).toBe("client-error");
		expect(h.attempted).toEqual(["http://small"]);
	});

	test("anthropic body-level overloaded_error on a 400 is retried, not passed through", async () => {
		const h = harness(
			(_u, n) =>
				n === 1
					? Response.json(
							{
								type: "error",
								error: { type: "overloaded_error", message: "busy" },
							},
							{ status: 400 },
						)
					: Response.json({ ok: 1 }),
			"anthropic",
		);
		const r = await h.run();
		expect(r.kind).toBe("upstream");
		expect(h.attempted.length).toBe(2);
	});

	test("body error.metadata.retry_after is honored", async () => {
		const h = harness((_u, n) =>
			n === 1
				? Response.json(
						{
							error: { message: "slow down", metadata: { retry_after: 0.25 } },
						},
						{ status: 429 },
					)
				: Response.json({ ok: 1 }),
		);
		await h.run();
		expect(h.slept).toEqual([250]);
	});

	test("auth 401 exhausts the tier and falls through the ladder", async () => {
		const h = harness((url) =>
			url === "http://small"
				? Response.json({ error: { message: "nope" } }, { status: 401 })
				: Response.json({ ok: 1 }),
		);
		const r = await h.run();
		expect(r.kind).toBe("upstream");
		expect(h.attempted).toEqual(["http://small", "http://big"]);
	});

	test("5xx with a bad_request body signature still fails over", async () => {
		const h = harness(
			(url) =>
				url === "http://small"
					? Response.json(
							{
								type: "error",
								error: { type: "invalid_request_error", message: "x" },
							},
							{ status: 500 },
						)
					: Response.json({ ok: 1 }),
			"anthropic",
		);
		const r = await h.run();
		expect(r.kind).toBe("upstream");
	});
});
