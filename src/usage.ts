// src/usage.ts — usage extraction from response payloads, both dialects.
// OpenAI shape: usage.{prompt_tokens, completion_tokens,
// prompt_tokens_details.cached_tokens}; Anthropic shape:
// usage.{input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens}. Absent usage is honest unknown — callers
// record requests without token columns rather than estimating.
export interface Usage {
	in_tok: number;
	out_tok: number;
	cache_r: number;
	cache_c: number;
}

type AnyRec = Record<string, unknown>;

const num = (v: unknown): number =>
	typeof v === "number" && Number.isFinite(v) ? v : 0;

export function usageFromOpenAI(u: unknown): Usage | null {
	if (!u || typeof u !== "object") return null;
	const r = u as AnyRec;
	const details = (r.prompt_tokens_details ?? {}) as AnyRec;
	const usage: Usage = {
		in_tok: num(r.prompt_tokens),
		out_tok: num(r.completion_tokens),
		cache_r: num(details.cached_tokens),
		cache_c: 0,
	};
	return hasTokens(usage) ? usage : null;
}

/** Anthropic usage objects, unwrapped by the caller: message_start carries
 *  usage under .message, message_delta flat under .usage — the SSE sniffer
 *  (sse.ts) handles the envelopes and feeds the flat usage object here. */
export function usageFromAnthropic(u: unknown): Usage | null {
	if (!u || typeof u !== "object") return null;
	const r = u as AnyRec;
	const usage: Usage = {
		in_tok: num(r.input_tokens),
		out_tok: num(r.output_tokens),
		cache_r: num(r.cache_read_input_tokens),
		cache_c: num(r.cache_creation_input_tokens),
	};
	return hasTokens(usage) ? usage : null;
}

function hasTokens(u: Usage): boolean {
	return u.in_tok > 0 || u.out_tok > 0 || u.cache_r > 0 || u.cache_c > 0;
}
