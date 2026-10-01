// test/e2e-anthropic.test.ts — anthropic-dialect round-trips: byte
// identity + message_start/message_delta usage tee + ledger.
import { describe, expect, test } from "bun:test";
import { startMockUpstream } from "./mock.ts";
import { testDeps } from "./deps.ts";
import { createApp, type AppDeps } from "../src/handlers.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

function deps(pool: UpstreamPool): AppDeps {
	return testDeps(pool);
}

function poolOf(url: string): UpstreamPool {
	return {
		groups: () => ["claude-sonnet-5"],
		deployments: (g) => [{ group: g, url, dialect: "anthropic" as const }],
	};
}

const FIXTURE =
	'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":6,"cache_read_input_tokens":1,"cache_creation_input_tokens":2}}}\n\n' +
	'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"yo"}}\n\n' +
	'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\n' +
	"event: message_stop\n\n";

describe("anthropic e2e", () => {
	test("non-streaming: passthrough + usage", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({
				id: "msg_1",
				usage: {
					input_tokens: 6,
					output_tokens: 3,
					cache_read_input_tokens: 1,
					cache_creation_input_tokens: 2,
				},
			}),
		);
		const d = deps(poolOf(upstream.url));
		const app = createApp(d);
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/messages`, {
				method: "POST",
				body: JSON.stringify({ model: "claude-sonnet-5", stream: false }),
			}),
		);
		expect(res.status).toBe(200);
		const out = (await res.json()) as { id: string };
		expect(out.id).toBe("msg_1");
		await Bun.sleep(10);
		const row = d.ledger.rows()[0] ?? {};
		expect(row.in_tok).toBe(6);
		expect(row.cache_r).toBe(1);
		expect(row.cache_c).toBe(2);
		upstream.close();
	});

	test("streaming: byte identity + message_delta output captured", async () => {
		const upstream = await startMockUpstream(
			() =>
				new Response(FIXTURE, {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		const d = deps(poolOf(upstream.url));
		const app = createApp(d);
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/messages`, {
				method: "POST",
				body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
			}),
		);
		const text = await res.text();
		expect(text).toBe(FIXTURE); // byte identity through the tee
		await Bun.sleep(10);
		const row = d.ledger.rows()[0] ?? {};
		expect(row.in_tok).toBe(6);
		expect(row.out_tok).toBe(3);
		expect(row.cache_r).toBe(1);
		expect(row.cache_c).toBe(2);
		upstream.close();
	});
});
