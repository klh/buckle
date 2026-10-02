// test/e2e-cross-dialect.test.ts — review #14 §1.3: cross-dialect failover
// is OPT-IN (BUCKLE_CROSS_DIALECT=on). Off: the walk never leaves the
// client's dialect. On: an anthropic client fails over to an openai
// upstream, streaming end-to-end through the W134 §5 transforms; an openai
// client fails over to an anthropic upstream (JSON).
import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/handlers.ts";
import type { Deployment, UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import { type MockUpstream, startMockUpstream } from "./mock.ts";

afterEach(() => {
	delete process.env.BUCKLE_CROSS_DIALECT;
});

const GROUP = "duo";

function poolOf(deps: Array<Omit<Deployment, "group">>): UpstreamPool {
	return {
		groups: () => [GROUP],
		deployments: (g) =>
			g === GROUP ? deps.map((d) => ({ ...d, group: g })) : [],
	};
}

const overloaded = (): Promise<MockUpstream> =>
	startMockUpstream(() =>
		Response.json(
			{ type: "error", error: { type: "overloaded_error", message: "busy" } },
			{ status: 529 },
		),
	);

const sse = (frames: unknown[]): string =>
	`${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")}data: [DONE]\n\n`;

const OPENAI_STREAM = sse([
	{
		id: "c1",
		model: "gpt-x",
		choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }],
	},
	{
		id: "c1",
		model: "gpt-x",
		choices: [{ index: 0, delta: { content: "lo ☃" } }],
	},
	{
		id: "c1",
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							function: { name: "get", arguments: '{"q":' },
						},
					],
				},
			},
		],
	},
	{
		id: "c1",
		choices: [
			{
				index: 0,
				delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] },
			},
		],
	},
	{ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
	{ id: "c1", choices: [], usage: { prompt_tokens: 21, completion_tokens: 9 } },
]);

function parseSse(
	text: string,
): Array<{ event: string; data: Record<string, unknown> }> {
	return text
		.split("\n\n")
		.filter((b) => b.trim().length > 0)
		.map((b) => {
			const ev = /^event: (.*)$/m.exec(b)?.[1] ?? "";
			const data = /^data: (.*)$/m.exec(b)?.[1] ?? "{}";
			return { event: ev, data: JSON.parse(data) as Record<string, unknown> };
		});
}

const anthropicReq = (url: string, stream: boolean): Request =>
	new Request(`${url}/v1/messages`, {
		method: "POST",
		body: JSON.stringify({
			model: GROUP,
			stream,
			max_tokens: 64,
			system: "be brief",
			messages: [{ role: "user", content: "hi" }],
			tools: [
				{ name: "get", description: "d", input_schema: { type: "object" } },
			],
		}),
	});

describe("cross-dialect failover (BUCKLE_CROSS_DIALECT)", () => {
	test("default off: an anthropic client never hops to an openai upstream", async () => {
		const ant = await overloaded();
		const oai = await startMockUpstream(() => Response.json({ id: "x" }));
		const d = testDeps(
			poolOf([
				{ url: ant.url, dialect: "anthropic" },
				{ url: oai.url, dialect: "openai" },
			]),
			{ sleepMs: async () => {} },
		);
		const res = await createApp(d).fetch(anthropicReq(ant.url, false));
		expect(res.status).toBe(502);
		expect(oai.calls.length).toBe(0);
		ant.close();
		oai.close();
	});

	test("on: anthropic streaming client fails over to openai, e2e SSE translated", async () => {
		process.env.BUCKLE_CROSS_DIALECT = "on";
		const ant = await overloaded();
		const oai = await startMockUpstream(
			() =>
				new Response(OPENAI_STREAM, {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		const d = testDeps(
			poolOf([
				{ url: ant.url, dialect: "anthropic" },
				{ url: oai.url, dialect: "openai" },
			]),
			{ sleepMs: async () => {} },
		);
		const res = await createApp(d).fetch(anthropicReq(ant.url, true));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		expect(JSON.parse(res.headers.get("x-belt-route") ?? "{}").decision).toBe(
			"fallback",
		);
		const events = parseSse(await res.text());
		expect(events.map((e) => e.event)).toEqual([
			"message_start",
			"content_block_start",
			"content_block_delta",
			"content_block_delta",
			"content_block_stop",
			"content_block_start",
			"content_block_delta",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);
		const text = events
			.filter((e) => (e.data.delta as { type?: string })?.type === "text_delta")
			.map((e) => (e.data.delta as { text: string }).text)
			.join("");
		expect(text).toBe("Hello ☃");
		const json = events
			.filter(
				(e) => (e.data.delta as { type?: string })?.type === "input_json_delta",
			)
			.map((e) => (e.data.delta as { partial_json: string }).partial_json)
			.join("");
		expect(JSON.parse(json)).toEqual({ q: "x" });
		const tool = events[5]?.data.content_block as Record<string, unknown>;
		expect(tool).toMatchObject({ type: "tool_use", id: "call_1", name: "get" });
		const md = events[9]?.data as {
			delta: { stop_reason: string };
			usage: { output_tokens: number; input_tokens: number };
		};
		expect(md.delta.stop_reason).toBe("tool_use");
		expect(md.usage).toEqual({ output_tokens: 9, input_tokens: 21 });

		// the openai leg got an openai body: system message, tools, usage opt-in
		const sent = oai.calls[0];
		expect(sent?.path).toBe("/v1/chat/completions");
		const body = sent?.body as Record<string, unknown>;
		expect((body.messages as Array<{ role: string }>)[0]?.role).toBe("system");
		expect(body.system).toBeUndefined();
		expect(body.stream_options).toEqual({ include_usage: true });
		expect((body.tools as Array<{ type: string }>)[0]?.type).toBe("function");

		await Bun.sleep(10);
		const row = d.ledger.rows()[0] ?? {};
		expect(row.in_tok).toBe(21);
		expect(row.out_tok).toBe(9);
		ant.close();
		oai.close();
	});

	test("on: anthropic JSON client gets an anthropic message from an openai upstream", async () => {
		process.env.BUCKLE_CROSS_DIALECT = "on";
		const ant = await overloaded();
		const oai = await startMockUpstream(() =>
			Response.json({
				id: "c2",
				model: "gpt-x",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "yo" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 4, completion_tokens: 2 },
			}),
		);
		const d = testDeps(
			poolOf([
				{ url: ant.url, dialect: "anthropic" },
				{ url: oai.url, dialect: "openai" },
			]),
			{ sleepMs: async () => {} },
		);
		const res = await createApp(d).fetch(anthropicReq(ant.url, false));
		expect(res.status).toBe(200);
		const msg = (await res.json()) as Record<string, unknown>;
		expect(msg).toMatchObject({
			type: "message",
			content: [{ type: "text", text: "yo" }],
			stop_reason: "end_turn",
		});
		await Bun.sleep(10);
		expect(d.ledger.rows()[0]?.in_tok).toBe(4);
		ant.close();
		oai.close();
	});

	test("on: openai JSON client fails over to an anthropic upstream", async () => {
		process.env.BUCKLE_CROSS_DIALECT = "on";
		const oaiDown = await startMockUpstream(() =>
			Response.json({ error: { message: "down" } }, { status: 503 }),
		);
		const ant = await startMockUpstream(() =>
			Response.json({
				id: "msg_9",
				type: "message",
				model: "claude-x",
				content: [{ type: "text", text: "hey" }],
				stop_reason: "end_turn",
				usage: { input_tokens: 7, output_tokens: 3 },
			}),
		);
		const d = testDeps(
			poolOf([
				{ url: oaiDown.url, dialect: "openai" },
				{ url: ant.url, dialect: "anthropic" },
			]),
			{ sleepMs: async () => {} },
		);
		const res = await createApp(d).fetch(
			new Request(`${ant.url}/v1/chat/completions`, {
				method: "POST",
				body: JSON.stringify({
					model: GROUP,
					messages: [
						{ role: "system", content: "s" },
						{ role: "user", content: "hi" },
					],
				}),
			}),
		);
		expect(res.status).toBe(200);
		const out = (await res.json()) as {
			object: string;
			choices: Array<{ message: { content: string }; finish_reason: string }>;
		};
		expect(out.object).toBe("chat.completion");
		expect(out.choices[0]?.message.content).toBe("hey");
		expect(out.choices[0]?.finish_reason).toBe("stop");
		const sent = ant.calls[0]?.body as Record<string, unknown>;
		expect(ant.calls[0]?.path).toBe("/v1/messages");
		expect(sent.system).toBe("s");
		expect(sent.max_tokens).toBe(4096);
		oaiDown.close();
		ant.close();
	});

	test("on: openai STREAMING client never hops to anthropic (no stream mirror)", async () => {
		process.env.BUCKLE_CROSS_DIALECT = "on";
		const oaiDown = await startMockUpstream(() =>
			Response.json({ error: { message: "down" } }, { status: 503 }),
		);
		const ant = await startMockUpstream(() => Response.json({ id: "x" }));
		const d = testDeps(
			poolOf([
				{ url: oaiDown.url, dialect: "openai" },
				{ url: ant.url, dialect: "anthropic" },
			]),
			{ sleepMs: async () => {} },
		);
		const res = await createApp(d).fetch(
			new Request(`${ant.url}/v1/chat/completions`, {
				method: "POST",
				body: JSON.stringify({
					model: GROUP,
					stream: true,
					messages: [{ role: "user", content: "hi" }],
				}),
			}),
		);
		expect(res.status).toBe(502);
		expect(ant.calls.length).toBe(0);
		oaiDown.close();
		ant.close();
	});
});
