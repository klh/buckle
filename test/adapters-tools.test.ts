// test/adapters-tools.test.ts — THE transform's golden + edge fixtures
// (W134 §5): field tables both directions, the streaming event mapping,
// parallel-call indexing, JSON-parse-fail reject-verbose.
import { describe, expect, test } from "bun:test";
import {
	OpenAIToAnthropicStream,
	requestAnthropicToOpenAI,
	requestOpenAIToAnthropic,
	responseAnthropicToOpenAI,
	responseOpenAIToAnthropic,
	stopReasonFromOpenAI,
} from "../src/adapters/tools.ts";

type AnyRec = Record<string, unknown>;

const names = (events: { event: string }[]): string[] =>
	events.map((e) => e.event);

const run = (chunks: unknown[]): { event: string; data: AnyRec }[] => {
	const s = new OpenAIToAnthropicStream();
	const out: { event: string; data: AnyRec }[] = [];
	for (const c of chunks) out.push(...s.push(c));
	out.push(...s.flush());
	return out;
};

describe("requestAnthropicToOpenAI", () => {
	test("field table: system, tools, tool_choice, tool_use/tool_result", () => {
		const r = requestAnthropicToOpenAI({
			model: "g",
			max_tokens: 64,
			system: "be brief",
			tools: [
				{
					name: "get_weather",
					description: "w",
					input_schema: { type: "object" },
				},
			],
			tool_choice: { type: "tool", name: "get_weather" },
			messages: [
				{ role: "user", content: "weather in paris?" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "checking" },
						{
							type: "tool_use",
							id: "tu_1",
							name: "get_weather",
							input: { city: "paris" },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tu_1",
							content: "sunny",
						},
						{ type: "text", text: "thanks" },
					],
				},
			],
		});
		expect(r.rejected).toBe(null);
		expect(r.body.system).toBe("be brief");
		expect(r.body.tools).toEqual([
			{
				type: "function",
				function: {
					name: "get_weather",
					description: "w",
					parameters: { type: "object" },
				},
			},
		]);
		expect(r.body.tool_choice).toEqual({
			type: "function",
			function: { name: "get_weather" },
		});
		const msgs = r.body.messages as AnyRec[];
		expect(msgs[0]).toEqual({ role: "user", content: "weather in paris?" });
		expect(msgs[1]).toEqual({
			role: "assistant",
			content: "checking",
			tool_calls: [
				{
					id: "tu_1",
					type: "function",
					function: {
						name: "get_weather",
						arguments: '{"city":"paris"}',
					},
				},
			],
		});
		expect(msgs[2]).toEqual({
			role: "tool",
			tool_call_id: "tu_1",
			content: "sunny",
		});
		expect(msgs[3]).toEqual({ role: "user", content: "thanks" });
	});

	test("thinking/top_k degrade; unknown field rejects naming it", () => {
		const r = requestAnthropicToOpenAI({
			model: "g",
			thinking: { type: "enabled" },
			frobnicate: 1,
		});
		expect(r.warnings[0]?.field).toBe("thinking");
		expect(r.rejected?.field).toBe("frobnicate");
	});
});

describe("responseOpenAIToAnthropic", () => {
	test("tool_calls → tool_use + stop_reason + usage", () => {
		const r = responseOpenAIToAnthropic({
			id: "c1",
			model: "m",
			choices: [
				{
					index: 0,
					finish_reason: "tool_calls",
					message: {
						role: "assistant",
						content: "hi",
						tool_calls: [
							{
								id: "call_1",
								type: "function",
								function: {
									name: "f",
									arguments: '{"a":1}',
								},
							},
						],
					},
				},
			],
			usage: { prompt_tokens: 7, completion_tokens: 2 },
		});
		expect(r.message.content).toEqual([
			{ type: "text", text: "hi" },
			{ type: "tool_use", id: "call_1", name: "f", input: { a: 1 } },
		]);
		expect(r.message.stop_reason).toBe("tool_use");
		expect(r.message.usage).toEqual({ input_tokens: 7, output_tokens: 2 });
		expect(r.warnings).toEqual([]);
	});

	test("JSON parse-fail → raw text block + warning (reject-verbose)", () => {
		const r = responseOpenAIToAnthropic({
			choices: [
				{
					finish_reason: "length",
					message: {
						tool_calls: [
							{
								id: "call_2",
								function: { name: "g", arguments: "oops{" },
							},
						],
					},
				},
			],
		});
		expect(r.message.content).toEqual([{ type: "text", text: "oops{" }]);
		expect(r.message.stop_reason).toBe("max_tokens");
		expect(r.warnings[0]?.field).toBe("tool_calls[call_2].arguments");
	});

	test("finish_reason maps", () => {
		expect(stopReasonFromOpenAI("length")).toBe("max_tokens");
		expect(stopReasonFromOpenAI("stop")).toBe("end_turn");
		expect(stopReasonFromOpenAI("content_filter")).toBe("refusal");
	});
});

describe("responseAnthropicToOpenAI", () => {
	test("tool_use → tool_calls + stop_reason + usage mirror", () => {
		const r = responseAnthropicToOpenAI({
			id: "msg_1",
			model: "m",
			content: [
				{ type: "text", text: "hey" },
				{ type: "tool_use", id: "tu_1", name: "f", input: { a: 1 } },
			],
			stop_reason: "max_tokens",
			usage: {
				input_tokens: 3,
				output_tokens: 4,
				cache_read_input_tokens: 2,
			},
		});
		const resp = r.response as AnyRec;
		const c = (resp.choices as AnyRec[])[0] as AnyRec;
		expect(c.finish_reason).toBe("length");
		expect((c.message as AnyRec).tool_calls).toEqual([
			{
				id: "tu_1",
				type: "function",
				function: { name: "f", arguments: '{"a":1}' },
			},
		]);
		expect(r.response.usage).toEqual({
			prompt_tokens: 3,
			completion_tokens: 4,
			prompt_tokens_details: { cached_tokens: 2 },
		});
	});
});

describe("requestOpenAIToAnthropic", () => {
	test("system/tools/tool_choice + role:tool → tool_result", () => {
		const r = requestOpenAIToAnthropic({
			model: "m",
			max_tokens: 32,
			temperature: 0.5,
			seed: 7,
			parallel_tool_calls: false,
			tools: [
				{
					type: "function",
					function: {
						name: "f",
						description: "d",
						parameters: { type: "object" },
					},
				},
			],
			tool_choice: "required",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: "hmm",
					tool_calls: [
						{
							id: "c1",
							type: "function",
							function: { name: "f", arguments: '{"a":1}' },
						},
					],
				},
				{ role: "tool", tool_call_id: "c1", content: "res" },
			],
		});
		expect(r.rejected).toBe(null);
		expect(r.body.system).toBe("sys");
		expect(r.body.tool_choice).toEqual({ type: "any" });
		expect(r.body.tools).toEqual([
			{ name: "f", description: "d", input_schema: { type: "object" } },
		]);
		const msgs = r.body.messages as AnyRec[];
		expect(msgs[0]).toEqual({ role: "user", content: "go" });
		expect(msgs[1]).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "hmm" },
				{ type: "tool_use", id: "c1", name: "f", input: { a: 1 } },
			],
		});
		expect(msgs[2]).toEqual({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "c1", content: "res" }],
		});
		const fields = r.warnings.map((w) => w.field);
		expect(fields).toContain("parallel_tool_calls");
		expect(fields).toContain("seed");
	});

	test("history parse-fail + unknown field = reject-verbose", () => {
		const bad = requestOpenAIToAnthropic({
			model: "m",
			messages: [
				{
					role: "assistant",
					tool_calls: [
						{
							id: "c9",
							function: { name: "f", arguments: "broken{" },
						},
					],
				},
			],
		});
		expect(bad.rejected?.field).toContain("arguments");
		const unknown = requestOpenAIToAnthropic({
			model: "m",
			messages: [],
			frobnicate: true,
		});
		expect(unknown.rejected?.field).toBe("frobnicate");
	});
});

describe("OpenAIToAnthropicStream", () => {
	const chunks = [
		{
			id: "c1",
			model: "m",
			choices: [{ index: 0, delta: { role: "assistant", content: "He" } }],
		},
		{ choices: [{ delta: { content: "y" } }] },
		{
			choices: [
				{
					delta: {
						tool_calls: [
							{
								index: 0,
								id: "call_1",
								type: "function",
								function: { name: "f", arguments: "" },
							},
						],
					},
				},
			],
		},
		{
			choices: [
				{
					delta: {
						tool_calls: [{ index: 0, function: { arguments: '{"a":' } }],
					},
				},
			],
		},
		{
			choices: [
				{
					delta: {
						tool_calls: [{ index: 0, function: { arguments: "1}" } }],
					},
				},
			],
		},
		{
			choices: [
				{
					delta: {
						tool_calls: [
							{
								index: 1,
								id: "call_2",
								type: "function",
								function: { name: "g", arguments: "" },
							},
						],
					},
				},
			],
		},
		{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		{ choices: [], usage: { prompt_tokens: 11, completion_tokens: 5 } },
	];

	test("golden: text → parallel tools → finish → usage at flush", () => {
		const events = run(chunks);
		expect(names(events)).toEqual([
			"message_start",
			"content_block_start",
			"content_block_delta",
			"content_block_delta",
			"content_block_stop",
			"content_block_start",
			"input_json_delta",
			"input_json_delta",
			"content_block_stop",
			"content_block_start",
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);
		expect(events[0]?.data.message).toEqual({
			id: "c1",
			type: "message",
			role: "assistant",
			model: "m",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 0, output_tokens: 0 },
		});
		expect(events[1]?.data).toEqual({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		});
		const json = events
			.filter((e) => e.event === "input_json_delta")
			.map((e) => e.data.partial_json)
			.join("");
		expect(json).toBe('{"a":1}');
		const starts = events.filter((e) => e.event === "content_block_start");
		expect(starts[1]?.data.content_block).toEqual({
			type: "tool_use",
			id: "call_1",
			name: "f",
			input: {},
		});
		expect(starts[2]?.data.content_block).toEqual({
			type: "tool_use",
			id: "call_2",
			name: "g",
			input: {},
		});
		expect(events.at(-2)?.data).toEqual({
			type: "message_delta",
			delta: { stop_reason: "tool_use", stop_sequence: null },
			usage: { output_tokens: 5 },
		});
	});
});

describe("OpenAIToAnthropicStream edges", () => {
	test("closed-block fragment reopens as a new block + warning", () => {
		const s = new OpenAIToAnthropicStream();
		s.push({
			choices: [
				{
					delta: {
						tool_calls: [
							{
								index: 0,
								id: "a",
								type: "function",
								function: { name: "f", arguments: "" },
							},
						],
					},
				},
			],
		});
		s.push({
			choices: [
				{
					delta: {
						tool_calls: [
							{
								index: 1,
								id: "b",
								type: "function",
								function: { name: "g", arguments: "" },
							},
						],
					},
				},
			],
		});
		const out = s.push({
			choices: [
				{
					delta: {
						tool_calls: [{ index: 0, function: { arguments: "x" } }],
					},
				},
			],
		});
		expect(names(out)).toEqual([
			"content_block_stop",
			"content_block_start",
			"input_json_delta",
		]);
		const reopened = out[1]?.data.content_block as AnyRec | undefined;
		expect(reopened?.id).toBe("a");
		expect(s.warnings.some((w) => w.field === "tool_calls[0]")).toBe(true);
	});

	test("flush exactly-once; never-started flushes empty; end_turn default", () => {
		const s = new OpenAIToAnthropicStream();
		expect(s.flush()).toEqual([]);
		s.push({ id: "e", model: "m", choices: [] });
		const f1 = s.flush();
		expect(names(f1)).toEqual(["message_delta", "message_stop"]);
		expect(s.flush()).toEqual([]);
		const delta = (f1[0]?.data ?? {}) as AnyRec;
		expect(delta.delta).toEqual({
			stop_reason: "end_turn",
			stop_sequence: null,
		});
	});
});
