// src/adapters/anthropic.ts — the Messages-API family (W134 tier 1):
// pass-through + count_tokens-capable + cache-token usage kinds. buildCall
// reproduces the pre-adapter wire.ts behavior byte-for-byte for anthropic
// dialects: model alias patch, Bearer auth, and NO stream_options (usage
// rides message_start + the cumulative message_delta natively).
import type { UpstreamRequest } from "../router.ts";
import type { Deployment } from "../upstreams.ts";
import { usageFromAnthropic } from "../usage.ts";
import { normalizeUpstreamError } from "./errors.ts";
import {
	bearerHeaders,
	type ChatAdapter,
	type WireCall,
	usageField,
} from "./types.ts";

export const ANTHROPIC: ChatAdapter = {
	family: "anthropic",
	dialect: "anthropic",
	// the anthropic family has the real count_tokens endpoint (W134 §5.3);
	// openai-dialect upstreams get the router's honest-estimate fallback
	caps: { countTokens: true, tools: true, streamOptions: false },

	async buildCall(
		dep: Deployment,
		req: UpstreamRequest,
		body: Record<string, unknown>,
	): Promise<WireCall> {
		const wire: Record<string, unknown> = {
			...body,
			model: dep.model ?? body.model,
		};
		return {
			url: new URL(req.path, dep.url).toString(),
			headers: bearerHeaders(dep),
			body: JSON.stringify(wire),
		};
	},

	// pass-through: read fields, never re-serialize the client leg
	parseResponse: (_dep, wire) => wire,

	normalizeError: (status, wire, headers) =>
		normalizeUpstreamError("anthropic", status, wire, headers),

	usageOf: (wire) => usageFromAnthropic(usageField(wire)),
};
