// test/adapters-wire.test.ts — tier-1 wire fixtures (in-test Bun.serve
// mocks per W134 §4.3) + registry fail-closed + the upstreams `adapter:`
// field (derive-from-dialect back-compat, unknown = startup fatal).
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { ANTHROPIC } from "../src/adapters/anthropic.ts";
import { getAdapter, resolveAdapter } from "../src/adapters/index.ts";
import { OPENAI_COMPAT } from "../src/adapters/openai-compat.ts";
import { loadUpstreams } from "../src/upstreams.ts";
import { defaultFetch } from "../src/wire.ts";
import { startMockUpstream } from "./mock.ts";

const OPENAI_REQ = {
	group: "g",
	dialect: "openai" as const,
	path: "/v1/chat/completions",
	body: {
		model: "alias",
		stream: true,
		stream_options: { foo: 1 },
		messages: [],
	},
	key: "",
};

describe("registry (fail closed)", () => {
	test("five families resolve; unknown names fail closed", () => {
		expect(getAdapter("openai-compat").family).toBe("openai-compat");
		expect(getAdapter("anthropic").dialect).toBe("anthropic");
		// W150: tier-2 ports landed — they resolve through the registry
		expect(getAdapter("azure-openai").family).toBe("azure-openai");
		expect(getAdapter("bedrock").family).toBe("bedrock");
		expect(getAdapter("vertex").family).toBe("vertex");
		expect(() =>
			resolveAdapter({ adapter: "nope", dialect: "openai" }),
		).toThrow(/unknown adapter/);
	});

	test("caps per W134 §5.3 + identity parseResponse", () => {
		expect(OPENAI_COMPAT.caps).toEqual({
			countTokens: false,
			tools: true,
			streamOptions: true,
		});
		expect(ANTHROPIC.caps).toEqual({
			countTokens: true,
			tools: true,
			streamOptions: false,
		});
		const wire = { id: "x" };
		const dep = { group: "g", url: "", dialect: "openai" as const };
		expect(OPENAI_COMPAT.parseResponse(dep, wire)).toBe(wire);
		expect(ANTHROPIC.parseResponse(dep, wire)).toBe(wire);
	});
});

describe("upstreams adapter field", () => {
	test("derive-from-dialect back-compat + explicit override", async () => {
		const upstream = await startMockUpstream(() => Response.json({ ok: true }));
		const dir = `/tmp/buckle-adapters-${Date.now()}`;
		const cfg =
			`groups:\n` +
			`  g1:\n    - url: ${upstream.url}\n      dialect: openai\n` +
			`  g2:\n    - url: ${upstream.url}\n      dialect: openai\n` +
			`      adapter: openai-compat\n`;
		await Bun.write(`${dir}/upstreams.yaml`, cfg);
		const pool = loadUpstreams(`${dir}/upstreams.yaml`);
		expect(pool.deployments("g1")[0]?.adapter).toBe("openai-compat");
		expect(pool.deployments("g2")[0]?.adapter).toBe("openai-compat");
		upstream.close();
	});

	test("unknown adapter = startup fatal naming the group", async () => {
		const dir = `/tmp/buckle-adapters-${Date.now()}`;
		const cfg =
			`groups:\n  bad:\n    - url: http://127.0.0.1:9\n` +
			`      dialect: openai\n      adapter: frobnicate\n`;
		await Bun.write(`${dir}/upstreams.yaml`, cfg);
		expect(() => loadUpstreams(`${dir}/upstreams.yaml`)).toThrow(/group "bad"/);
	});
});

describe("tier-2 family named in config (W150)", () => {
	test("bedrock named in config loads; resolution is deferred to request time", () => {
		const dir = `/tmp/buckle-adapters-${Date.now()}`;
		const cfg =
			`groups:\n  aws:\n    - url: http://127.0.0.1:9\n` +
			`      dialect: openai\n      adapter: bedrock\n`;
		const p = `${dir}/u.yaml`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(p, cfg);
		const pool = loadUpstreams(p);
		const dep = pool.deployments("aws")[0];
		expect(dep?.adapter).toBe("bedrock");
	});
});

describe("openai-compat buildCall (request fixtures)", () => {
	test("model patch + include_usage injection", async () => {
		const upstream = await startMockUpstream(() => Response.json({ id: "1" }));
		const dep = {
			group: "g",
			url: upstream.url,
			dialect: "openai" as const,
			model: "real-model",
		};
		await defaultFetch(dep, OPENAI_REQ, 5000);
		const sent = upstream.calls[0];
		expect(sent?.path).toBe("/v1/chat/completions");
		expect(sent?.body).toEqual({
			model: "real-model",
			stream: true,
			stream_options: { foo: 1, include_usage: true },
			messages: [],
		});
		expect(sent?.auth).toBe(null);
		upstream.close();
	});

	test("bearer auth from api_key_env", async () => {
		const upstream = await startMockUpstream(() => Response.json({ id: "1" }));
		const dep = {
			group: "g",
			url: upstream.url,
			dialect: "openai" as const,
			api_key_env: "W139_TEST_KEY",
		};
		process.env.W139_TEST_KEY = "sk-w139-test";
		try {
			await defaultFetch(dep, { ...OPENAI_REQ, body: { model: "m" } }, 5000);
		} finally {
			delete process.env.W139_TEST_KEY;
		}
		expect(upstream.calls[0]?.auth).toBe("Bearer sk-w139-test");
		upstream.close();
	});
});

describe("anthropic buildCall", () => {
	test("model patch, no stream_options on the anthropic wire", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "msg_1" }),
		);
		const dep = {
			group: "g",
			url: upstream.url,
			dialect: "anthropic" as const,
			model: "claude-real",
		};
		await defaultFetch(
			dep,
			{
				...OPENAI_REQ,
				dialect: "anthropic" as const,
				path: "/v1/messages",
				body: { model: "alias", stream: true },
			},
			5000,
		);
		const sent = upstream.calls[0];
		expect(sent?.path).toBe("/v1/messages");
		expect(sent?.body).toEqual({ model: "claude-real", stream: true });
		upstream.close();
	});
});

describe("usageOf per family", () => {
	test("each adapter reads its own usage shape", () => {
		expect(
			OPENAI_COMPAT.usageOf({
				usage: { prompt_tokens: 2, completion_tokens: 3 },
			}),
		).toEqual({ in_tok: 2, out_tok: 3, cache_r: 0, cache_c: 0 });
		expect(
			ANTHROPIC.usageOf({
				usage: {
					input_tokens: 5,
					output_tokens: 0,
					cache_read_input_tokens: 1,
				},
			}),
		).toEqual({ in_tok: 5, out_tok: 0, cache_r: 1, cache_c: 0 });
		expect(OPENAI_COMPAT.usageOf({})).toBe(null);
	});
});
