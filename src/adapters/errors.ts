// src/adapters/errors.ts — the RouterError taxonomy (W134 §1): seven
// normalized kinds with per-family mappings — family exception types never
// leak past this file (LiteLLM exceptions.py anchors :131/:355/:441/:534/
// :663/:852). retry-after is honored from the header (both forms) or the
// body error.metadata; the ladder keys retry policy on kind + retryable.
import { retryAfterS } from "../cooldown.ts";
import type { AdapterFamily } from "./types.ts";

export type ErrorKind =
	| "rate_limited"
	| "overloaded"
	| "timeout"
	| "network"
	| "auth"
	| "bad_request"
	| "server";

const RETRYABLE: Record<ErrorKind, boolean> = {
	rate_limited: true,
	overloaded: true,
	timeout: true,
	network: true,
	server: true,
	auth: false,
	bad_request: false,
};

/** One upstream failure, normalized. kind + retryable drive the ladder;
 *  contextWindow flags the bad_request subclass the ladder reacts to
 *  (shrink/shim) rather than plain-failing (LiteLLM exceptions.py:534
 *  ContextWindowExceededError). */
export class RouterError extends Error {
	constructor(
		public readonly kind: ErrorKind,
		public readonly status: number,
		message: string,
		public readonly family: AdapterFamily | null = null,
		public readonly retryAfterS: number | null = null,
		public readonly contextWindow = false,
	) {
		super(message);
	}

	/** retryable per the W134 §1 table: rate_limited/overloaded/timeout/
	 *  network/server yes; auth/bad_request no. */
	get retryable(): boolean {
		return RETRYABLE[this.kind];
	}
}

type AnyRec = Record<string, unknown>;

/** Per-family body error-type signatures (W134 §1 table). openai-compat
 *  bodies carry no stable type taxonomy — status-driven only. */
const SIGNATURES: Partial<Record<AdapterFamily, Record<string, ErrorKind>>> = {
	anthropic: {
		rate_limit_error: "rate_limited",
		overloaded_error: "overloaded",
		authentication_error: "auth",
		permission_error: "auth",
		invalid_request_error: "bad_request",
		not_found_error: "bad_request",
		request_too_large: "bad_request",
		api_error: "server",
	},
	"azure-openai": { content_filter: "bad_request" },
	bedrock: {
		ThrottlingException: "rate_limited",
		ValidationException: "bad_request",
		ModelNotFoundException: "bad_request",
		ServiceUnavailableException: "server",
	},
	vertex: {
		RESOURCE_EXHAUSTED: "rate_limited",
		UNAVAILABLE: "overloaded",
		INVALID_ARGUMENT: "bad_request",
		FAILED_PRECONDITION: "bad_request",
		INTERNAL: "server",
	},
};

/** Status-code fallbacks per family (W134 §1 table rows). */
const STATUS_KINDS: Partial<Record<AdapterFamily, Record<number, ErrorKind>>> =
	{
		"openai-compat": {
			408: "timeout",
			401: "auth",
			403: "auth",
			404: "bad_request",
			413: "bad_request",
			422: "bad_request",
			429: "rate_limited",
			503: "overloaded",
		},
		anthropic: {
			401: "auth",
			403: "auth",
			404: "bad_request",
			413: "bad_request",
			429: "rate_limited",
			529: "overloaded",
		},
	};

const TIER2_STATUS: Partial<Record<AdapterFamily, Record<number, ErrorKind>>> =
	{
		"azure-openai": {
			400: "bad_request",
			401: "auth",
			403: "auth",
			404: "bad_request",
			429: "rate_limited",
		},
		bedrock: {
			400: "bad_request",
			403: "auth",
			404: "bad_request",
			408: "timeout",
			429: "rate_limited",
			503: "server",
		},
		vertex: {
			400: "bad_request",
			401: "auth",
			403: "auth",
			429: "rate_limited",
			503: "overloaded",
		},
	};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The wire body's error object (openai/anthropic/vertex shapes), if any. */
function errorOf(wire: unknown): AnyRec | null {
	if (!wire || typeof wire !== "object") return null;
	const e = (wire as AnyRec).error;
	if (!e || typeof e !== "object") return null;
	return e as AnyRec;
}

/** Per-family extraction of the body's error-type signature string. */
function signature(family: AdapterFamily, wire: unknown): string {
	if (family === "bedrock") {
		// Converse error frames: {__type:"ThrottlingException"} (optionally
		// namespace-prefixed) or nested {error:{__type:...}}
		const r = wire as AnyRec | null;
		if (!r || typeof r !== "object") return "";
		const t = str(r.__type) || str(errorOf(r)?.__type);
		return t.replace(/^.*#/, "");
	}
	if (family === "vertex") return str(errorOf(wire)?.status);
	if (family === "azure-openai") {
		return str(errorOf(wire)?.code) || str(errorOf(wire)?.type);
	}
	return str(errorOf(wire)?.type);
}

const CONTEXT_WINDOW =
	/context.{0,12}(length|window)|maximum context|prompt is too long|too many (input )?tokens|context_length_exceeded/i;

/** bad_request subclass detector (context-window overflow): the ladder
 *  shrinks/shims on this instead of plain-failing. */
function isContextWindow(wire: unknown): boolean {
	const r = (wire ?? {}) as AnyRec;
	const e = errorOf(wire);
	const msg = [str(r.message), str(e?.message), str(e?.code)].join(" ");
	return CONTEXT_WINDOW.test(msg);
}

/** retry-after: header first (both forms — cooldown.ts parsing), then the
 *  body error.metadata (W134 §1: header or body error.metadata). */
function retryAfterOf(headers: Headers | null, wire: unknown): number | null {
	if (headers) {
		const v = retryAfterS(headers);
		if (v !== null) return v;
	}
	const meta = errorOf(wire)?.metadata as AnyRec | undefined;
	const raw = meta?.retry_after;
	if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, raw);
	if (typeof raw === "string") {
		const n = Number(raw);
		if (Number.isFinite(n)) return Math.max(0, n);
	}
	return null;
}

function errorMessage(wire: unknown, status: number): string {
	const e = errorOf(wire);
	const msg = str(e?.message) || str((wire as AnyRec)?.message);
	return msg.length > 0 ? msg : `upstream error ${String(status)}`;
}

/** status/body/headers → RouterError. Precedence: body signature → status
 *  map → 5xx/short-fallback (5xx→server, other→bad_request). */
export function normalizeUpstreamError(
	family: AdapterFamily,
	status: number,
	wire: unknown,
	headers: Headers | null = null,
): RouterError {
	const table = SIGNATURES[family];
	const sig = signature(family, wire);
	const fromSig = sig.length > 0 && table ? table[sig] : undefined;
	const fromStatus: ErrorKind | undefined =
		STATUS_KINDS[family]?.[status] ?? TIER2_STATUS[family]?.[status];
	const kind: ErrorKind =
		fromSig ??
		fromStatus ??
		(status >= 500 || status < 400 ? "server" : "bad_request");
	const contextWindow = kind === "bad_request" && isContextWindow(wire);
	return new RouterError(
		kind,
		status,
		errorMessage(wire, status),
		family,
		retryAfterOf(headers, wire),
		contextWindow,
	);
}

/** fetch-throw normalization: abort/timeout vs network (the W134 §1 table's
 *  "abort" rows). Caller aborts rethrow above this — transport only. */
export function networkFromThrow(
	e: unknown,
	signal?: AbortSignal | null,
): RouterError {
	if (signal?.aborted)
		return new RouterError("timeout", 0, "caller aborted the request");
	const name = e instanceof Error ? e.name : "";
	const timeout = name === "AbortError" || name === "TimeoutError";
	return new RouterError(
		timeout ? "timeout" : "network",
		0,
		e instanceof Error ? e.message : "fetch failed",
	);
}
