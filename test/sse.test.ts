// test/sse.test.ts — the usage sniffer: terminal-chunk semantics.
import { describe, expect, test } from "bun:test";
import { SseSniffer } from "../src/sse.ts";

describe("SseSniffer (openai)", () => {
	test("usage from the final chunk (include_usage honored)", () => {
		const s = new SseSniffer("openai");
		s.push(
			'data: {"id":"c","choices":[{"delta":{"content":"hi"}}]}\n\n' +
				'data: {"id":"c","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\n' +
				"data: [DONE]\n\n",
		);
		s.flush();
		const u = s.usage();
		expect(u?.in_tok).toBe(11);
		expect(u?.out_tok).toBe(7);
	});

	test("no usage seen → null (honest unknown, never fake zeros)", () => {
		const s = new SseSniffer("openai");
		s.push('data: {"id":"c","choices":[{"delta":{"content":"x"}}]}\n\n');
		s.flush();
		expect(s.usage()).toBeNull();
	});
});

describe("SseSniffer (anthropic)", () => {
	test("message_start input side + message_delta cumulative output", () => {
		const s = new SseSniffer("anthropic");
		s.push(
			"event: message_start\n" +
				'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}\n\n' +
				"event: message_delta\n" +
				'data: {"type":"message_delta","usage":{"output_tokens":9}}\n\n' +
				"event: message_stop\n\n",
		);
		const u = s.usage();
		expect(u?.in_tok).toBe(5);
		expect(u?.out_tok).toBe(9);
		expect(u?.cache_r).toBe(3);
		expect(u?.cache_c).toBe(2);
	});

	test("keep-alive comments ignored; chunk-boundary splits handled", () => {
		const s = new SseSniffer("anthropic");
		s.push(": ping\n\nevent: message_start\n");
		s.push(
			'data: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n',
		);
		s.push("\n\n");
		s.push("event: message_delta\n");
		s.push('data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n');
		s.flush();
		const u = s.usage();
		expect(u?.in_tok).toBe(4);
		expect(u?.out_tok).toBe(2);
	});
});
