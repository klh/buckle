// src/adapters/types.ts — the adapter contract (W134 §1): a port of
// LiteLLM's BaseConfig ABC (llms/base_llm/chat/transformation.py:69, MIT;
// anchors :187/:237/:247/:259/:284/:305/:337/:365/:368) reshaped for
// pass-through-first: the pass-through families implement almost nothing,
// so identity must be free, not inherited overhead. Families, not
// providers — the tier-3 long tail is data rows, never new adapters.
import type { UpstreamRequest } from "../router.ts";
import type { Dialect, Deployment } from "../upstreams.ts";
import type { Usage } from "../usage.ts";
import type { RouterError } from "./errors.ts";

/** The five wire families. Tier-1 ships openai-compat + anthropic;
 *  azure-openai / bedrock / vertex are tier-2 ports (W134 §3). */
export type AdapterFamily =
	| "openai-compat"
	| "anthropic"
	| "azure-openai"
	| "bedrock"
	| "vertex";

export const ADAPTER_FAMILIES: readonly AdapterFamily[] = [
	"openai-compat",
	"anthropic",
	"azure-openai",
	"bedrock",
	"vertex",
];

export function isAdapterFamily(v: unknown): v is AdapterFamily {
	return (
		typeof v === "string" && (ADAPTER_FAMILIES as readonly string[]).includes(v)
	);
}

/** Absent `adapter:` derives from the deployment dialect (W134 §4.2) — the
 *  committed upstreams.yaml needs no migration. */
export function deriveAdapter(dialect: Dialect): AdapterFamily {
	return dialect === "anthropic" ? "anthropic" : "openai-compat";
}

/** One upstream attempt's wire call, ready for fetch(). */
export interface WireCall {
	url: string;
	headers: Record<string, string>;
	body: string;
}

/** Capability flags the router advertises and enforces (W134 §5.3: a
 *  countTokens=false family routes count_tokens to the honest estimate). */
export interface AdapterCaps {
	countTokens: boolean;
	tools: boolean;
	streamOptions: boolean;
}

/** ChatAdapter — one wire family. Auth lives inside buildCall (the
 *  sign_request seam, transformation.py:259); refresh failures normalize
 *  to auth RouterErrors, never crash the attempt loop. Every upstream
 *  error surfaces normalized — no family exception types leak past
 *  errors.ts. */
export interface ChatAdapter {
	readonly family: AdapterFamily;
	/** wire shape spoken on the upstream leg once buildCall is done */
	readonly dialect: Dialect;
	/** per attempt: URL + auth (may refresh tokens) + body patches.
	 *  Pass-through families patch only (model id, stream_options);
	 *  transform families rewrite (Converse, generateContent). */
	buildCall(
		dep: Deployment,
		req: UpstreamRequest,
		body: Record<string, unknown>,
	): Promise<WireCall>;
	/** non-streaming reply → canonical response (identity for pass-through
	 *  families: read fields, never re-serialize the client leg) */
	parseResponse(dep: Deployment, wire: unknown): unknown;
	/** status/body/headers → normalized RouterError */
	normalizeError(
		status: number,
		wire: unknown,
		headers: Headers | null,
	): RouterError;
	/** usage extraction — non-streaming payload or a single SSE event */
	usageOf(wire: unknown): Usage | null;
	readonly caps: AdapterCaps;
}

/** Shared auth header profile for bearer families: the key never lives in
 *  config — api_key_env names the env var read at request time. */
export function bearerHeaders(dep: Deployment): Record<string, string> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (dep.api_key_env) {
		const token = process.env[dep.api_key_env];
		if (token) headers.authorization = `Bearer ${token}`;
	}
	return headers;
}

/** The `usage` field of a response envelope, unwrapped for usageOf. */
export function usageField(wire: unknown): unknown {
	if (!wire || typeof wire !== "object") return undefined;
	return (wire as Record<string, unknown>).usage;
}
