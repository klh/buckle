// test/sse-parser.test.ts — review #13 §1.3: multi-line data joined,
// eventType reset at the blank line, one streaming TextDecoder across chunks.
import { describe, expect, test } from "bun:test";
import { SseSniffer } from "../src/sse.ts";

const enc = new TextEncoder();

describe("SseSniffer parser correctness", () => {
	test("multi-line data: frames are joined before JSON.parse", () => {
		const s = new SseSniffer("openai");
		s.push(
			'data: {"id":"c","choices":[],\n' +
				'data: "usage":{"prompt_tokens":5,\n' +
				'data: "completion_tokens":2}}\n\n',
		);
		s.flush();
		expect(s.usage()).toEqual({
			in_tok: 5,
			out_tok: 2,
			cache_r: 0,
			cache_c: 0,
		});
	});

	test("eventType resets on the blank line (no leak into the next event)", () => {
		const s = new SseSniffer("anthropic");
		s.push(
			"event: message_start\n" +
				'data: {"message":{"usage":{"input_tokens":9,"output_tokens":1}}}\n\n' +
				// untyped event after the boundary must NOT inherit message_start
				'data: {"message":{"usage":{"input_tokens":999,"output_tokens":1}}}\n\n',
		);
		s.flush();
		expect(s.usage()?.in_tok).toBe(9);
	});

	test("multibyte UTF-8 split across chunks decodes intact", () => {
		const s = new SseSniffer("openai");
		const bytes = enc.encode(
			'data: {"x":"héllo ☃","usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n',
		);
		const cut = bytes.indexOf(0xe2) + 1; // inside the 3-byte snowman
		s.push(bytes.slice(0, cut));
		s.push(bytes.slice(cut));
		s.flush();
		expect(s.usage()?.out_tok).toBe(4);
	});

	test("byte-at-a-time feed + CRLF line endings", () => {
		const s = new SseSniffer("openai");
		const bytes = enc.encode(
			'data: {"é":1,"usage":{"prompt_tokens":1,"completion_tokens":8}}\r\n\r\n',
		);
		for (const b of bytes) s.push(new Uint8Array([b]));
		s.flush();
		expect(s.usage()?.out_tok).toBe(8);
	});

	test("tail event without a closing blank line dispatches at flush", () => {
		const s = new SseSniffer("openai");
		s.push('data: {"usage":{"prompt_tokens":2,"completion_tokens":2}}');
		s.flush();
		expect(s.usage()?.in_tok).toBe(2);
	});
});
