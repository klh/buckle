// src/adapters/openai-compat.ts — the generic openai-wire family (W134
// tier 1): OpenAI, z.ai, OpenRouter, vLLM, LM Studio, one-api-class shims
// and local MLX/Ollama servers are ONE adapter; the provider long tail is
// data rows, never code. buildCall reproduces the pre-adapter wire.ts
// behavior byte-for-byte (model alias patch + stream_options.include_usage
// injection; LiteLLM streaming_handler.py include_usage semantics, MIT) —
// the 37-test regression net pins the bytes.
import type { UpstreamRequest } from "../router.ts";
import type { Deployment } from "../upstreams.ts";
import { usageFromOpenAI } from "../usage.ts";
import { normalizeUpstreamError } from "./errors.ts";
import {
	bearerHeaders,
	type ChatAdapter,
	type WireCall,
	usageField,
} from "./types.ts";

export const OPENAI_COMPAT: ChatAdapter = {
	family: "openai-compat",
	dialect: "openai",
	caps: { countTokens: false, tools: true, streamOptions: true },

	async buildCall(
		dep: Deployment,
		req: UpstreamRequest,
		body: Record<string, unknown>,
	): Promise<WireCall> {
		const wire: Record<string, unknown> = {
			...body,
			model: dep.model ?? body.model,
		};
		if (wire.stream === true) {
			const prior = (wire.stream_options ?? {}) as Record<string, unknown>;
			wire.stream_options = { ...prior, include_usage: true };
		}
		return {
			url: new URL(req.path, dep.url).toString(),
			headers: bearerHeaders(dep),
			body: JSON.stringify(wire),
		};
	},

	// pass-through: read fields, never re-serialize the client leg
	parseResponse: (_dep, wire) => wire,

	normalizeError: (status, wire, headers) =>
		normalizeUpstreamError("openai-compat", status, wire, headers),

	usageOf: (wire) => usageFromOpenAI(usageField(wire)),
};
