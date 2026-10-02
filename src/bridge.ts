// src/bridge.ts — cross-dialect failover (review #14 §1.3), OPT-IN behind
// BUCKLE_CROSS_DIALECT=on (default off: buckle is dual-dialect
// pass-through). When on, a ladder rung may hop to a deployment of the
// OTHER dialect; the request/response are rewritten with the W134 §5
// transforms in adapters/tools.ts. Supported hops:
//   anthropic client → openai upstream: JSON + streaming (OpenAIToAnthropicStream)
//   openai client → anthropic upstream: JSON only (no anthropic→openai
//     stream mirror exists yet — streaming requests never take this hop)
// count_tokens never bridges. A transform that rejects (reject-verbose)
// makes the hop ineligible — the walk skips it, nothing is mangled.
import {
	type AnthropicEvent,
	OpenAIToAnthropicStream,
	requestAnthropicToOpenAI,
	requestOpenAIToAnthropic,
	responseAnthropicToOpenAI,
	responseOpenAIToAnthropic,
} from "./adapters/tools.ts";
import type { UpstreamRequest } from "./router.ts";
import type { Deployment, Dialect } from "./upstreams.ts";

type AnyRec = Record<string, unknown>;

export function crossDialectOn(): boolean {
	return process.env.BUCKLE_CROSS_DIALECT === "on";
}

const PATH: Record<Dialect, string> = {
	openai: "/v1/chat/completions",
	anthropic: "/v1/messages",
};

/** Anthropic requires max_tokens; openai bodies often omit it. */
const DEFAULT_MAX_TOKENS = 4096;

/** The request rewritten for dep's dialect, or null = hop not eligible. */
export function bridgeRequest(
	req: UpstreamRequest,
	dep: Deployment,
): UpstreamRequest | null {
	if (dep.dialect === req.dialect) return req;
	if (req.path !== PATH[req.dialect]) return null; // count_tokens etc.
	const stream = req.body.stream === true;
	if (req.dialect === "anthropic") {
		const t = requestAnthropicToOpenAI(req.body);
		if (t.rejected) return null;
		const { system, ...rest } = t.body;
		const messages = Array.isArray(rest.messages) ? rest.messages : [];
		const body: AnyRec = {
			...rest,
			messages:
				typeof system === "string" && system.length > 0
					? [{ role: "system", content: system }, ...messages]
					: messages,
		};
		return { ...req, dialect: "openai", path: PATH.openai, body };
	}
	if (stream) return null;
	const pre: AnyRec = { ...req.body };
	if (pre.max_tokens === undefined && pre.max_completion_tokens !== undefined)
		pre.max_tokens = pre.max_completion_tokens;
	delete pre.max_completion_tokens;
	delete pre.stream_options; // anthropic always reports usage
	const t = requestOpenAIToAnthropic(pre);
	if (t.rejected) return null;
	const body: AnyRec = { max_tokens: DEFAULT_MAX_TOKENS, ...t.body };
	return { ...req, dialect: "anthropic", path: PATH.anthropic, body };
}

/** Upstream reply (dep's dialect) → the client's dialect. */
export function bridgeResponse(
	resp: Response,
	client: Dialect,
	stream: boolean,
): Response {
	const headers = new Headers(resp.headers);
	headers.delete("content-length");
	headers.delete("content-encoding");
	if (stream && client === "anthropic" && resp.body) {
		headers.set("content-type", "text/event-stream");
		return new Response(resp.body.pipeThrough(openAIToAnthropicSse()), {
			status: resp.status,
			headers,
		});
	}
	headers.set("content-type", "application/json");
	const body = resp.text().then((text) => {
		let wire: AnyRec = {};
		try {
			wire = JSON.parse(text) as AnyRec;
		} catch {
			return text; // not JSON: surface verbatim, never fabricate
		}
		const out =
			client === "anthropic"
				? responseOpenAIToAnthropic(wire).message
				: responseAnthropicToOpenAI(wire).response;
		return JSON.stringify(out);
	});
	return new Response(
		new ReadableStream<Uint8Array>({
			async start(c) {
				c.enqueue(new TextEncoder().encode(await body));
				c.close();
			},
		}),
		{ status: resp.status, headers },
	);
}

/** Wire form of one transform event. tools.ts emits tool argument
 *  fragments as a bare `input_json_delta` event; on the anthropic wire they
 *  ride content_block_delta, and message_delta carries input_tokens so the
 *  usage tee sees the prompt side (OpenAI reports it only at the end). */
function wireEvent(e: AnthropicEvent, inTok: number): string {
	let event = e.event;
	let data: AnyRec = e.data;
	if (e.event === "input_json_delta") {
		event = "content_block_delta";
		data = {
			type: "content_block_delta",
			index: e.data.index,
			delta: { type: "input_json_delta", partial_json: e.data.partial_json },
		};
	} else if (e.event === "message_delta" && inTok > 0) {
		data = {
			...e.data,
			usage: { ...(e.data.usage as AnyRec), input_tokens: inTok },
		};
	}
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** openai SSE bytes → anthropic SSE bytes (streaming, one decoder). */
export function openAIToAnthropicSse(): TransformStream<
	Uint8Array,
	Uint8Array
> {
	const dec = new TextDecoder();
	const enc = new TextEncoder();
	const tx = new OpenAIToAnthropicStream();
	let buf = "";
	let data: string[] = [];
	const emit = (
		events: AnthropicEvent[],
		c: TransformStreamDefaultController<Uint8Array>,
	): void => {
		const inTok = tx.seenUsage()?.in_tok ?? 0;
		const text = events.map((e) => wireEvent(e, inTok)).join("");
		if (text.length > 0) c.enqueue(enc.encode(text));
	};
	const dispatch = (c: TransformStreamDefaultController<Uint8Array>): void => {
		const payload = data.join("\n").trim();
		data = [];
		if (payload.length === 0 || payload === "[DONE]") return;
		try {
			emit(tx.push(JSON.parse(payload)), c);
		} catch {
			// non-JSON frame: nothing to translate
		}
	};
	const line = (
		l: string,
		c: TransformStreamDefaultController<Uint8Array>,
	): void => {
		if (l.length === 0) dispatch(c);
		else if (l.startsWith("data:")) {
			const v = l.slice(5);
			data.push(v.startsWith(" ") ? v.slice(1) : v);
		}
	};
	const drain = (c: TransformStreamDefaultController<Uint8Array>): void => {
		let i = buf.indexOf("\n");
		while (i >= 0) {
			line(buf.slice(0, i).replace(/\r$/, ""), c);
			buf = buf.slice(i + 1);
			i = buf.indexOf("\n");
		}
	};
	return new TransformStream({
		transform(chunk, c) {
			buf += dec.decode(chunk, { stream: true });
			drain(c);
		},
		flush(c) {
			buf += `${dec.decode()}\n`;
			drain(c);
			dispatch(c);
			emit(tx.flush(), c);
		},
	});
}
