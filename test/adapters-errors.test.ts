// test/adapters-errors.test.ts — RouterError taxonomy goldens: per-family
// status/body mappings per the W134 §1 table, retry-after forms, the
// context-window subclass, fetch-throw normalization.
import { describe, expect, test } from "bun:test";
import {
	networkFromThrow,
	normalizeUpstreamError,
} from "../src/adapters/errors.ts";
import type { AdapterFamily } from "../src/adapters/types.ts";

const kindOf = (
	family: AdapterFamily,
	status: number,
	wire: unknown = {},
): string => normalizeUpstreamError(family, status, wire).kind;

describe("openai-compat (status-driven)", () => {
	test("the W134 §1 status table", () => {
		expect(kindOf("openai-compat", 429)).toBe("rate_limited");
		expect(kindOf("openai-compat", 503)).toBe("overloaded");
		expect(kindOf("openai-compat", 408)).toBe("timeout");
		expect(kindOf("openai-compat", 401)).toBe("auth");
		expect(kindOf("openai-compat", 403)).toBe("auth");
		expect(kindOf("openai-compat", 400)).toBe("bad_request");
		expect(kindOf("openai-compat", 404)).toBe("bad_request");
		expect(kindOf("openai-compat", 422)).toBe("bad_request");
		expect(kindOf("openai-compat", 413)).toBe("bad_request");
		expect(kindOf("openai-compat", 500)).toBe("server");
		expect(kindOf("openai-compat", 502)).toBe("server");
		expect(kindOf("openai-compat", 409)).toBe("bad_request");
	});

	test("context-window subclass on bad_request", () => {
		const r = normalizeUpstreamError("openai-compat", 400, {
			error: {
				message: "This model's maximum context length is 8192 tokens",
			},
		});
		expect(r.kind).toBe("bad_request");
		expect(r.contextWindow).toBe(true);
		const plain = normalizeUpstreamError("openai-compat", 400, {
			error: { message: "missing field" },
		});
		expect(plain.contextWindow).toBe(false);
	});

	test("retryability per kind", () => {
		const r = (s: number) => normalizeUpstreamError("openai-compat", s, {});
		expect(r(429).retryable).toBe(true);
		expect(r(500).retryable).toBe(true);
		expect(r(401).retryable).toBe(false);
		expect(r(400).retryable).toBe(false);
	});
});

describe("anthropic", () => {
	test("body signatures (status 500 body beats the status fallback)", () => {
		expect(
			kindOf("anthropic", 529, {
				type: "error",
				error: { type: "overloaded_error" },
			}),
		).toBe("overloaded");
		expect(
			kindOf("anthropic", 429, {
				error: { type: "rate_limit_error" },
			}),
		).toBe("rate_limited");
		expect(
			kindOf("anthropic", 401, {
				error: { type: "authentication_error" },
			}),
		).toBe("auth");
		expect(
			kindOf("anthropic", 400, {
				error: { type: "invalid_request_error" },
			}),
		).toBe("bad_request");
		expect(kindOf("anthropic", 500, { error: { type: "api_error" } })).toBe(
			"server",
		);
	});

	test("anthropic context-window message", () => {
		const r = normalizeUpstreamError("anthropic", 400, {
			error: {
				type: "invalid_request_error",
				message: "prompt is too long: 12 tokens > 8 maximum",
			},
		});
		expect(r.contextWindow).toBe(true);
	});
});

describe("tier-2 families (mapping table ships ahead of the ports)", () => {
	test("bedrock Converse error frames", () => {
		expect(kindOf("bedrock", 429, { __type: "ThrottlingException" })).toBe(
			"rate_limited",
		);
		expect(
			kindOf("bedrock", 400, {
				__type: "com.amazonaws.#ValidationException",
			}),
		).toBe("bad_request");
		expect(kindOf("bedrock", 404, { __type: "ModelNotFoundException" })).toBe(
			"bad_request",
		);
		expect(
			kindOf("bedrock", 503, { __type: "ServiceUnavailableException" }),
		).toBe("server");
		expect(kindOf("bedrock", 403, {})).toBe("auth");
	});

	test("vertex error.status signatures", () => {
		expect(
			kindOf("vertex", 429, { error: { status: "RESOURCE_EXHAUSTED" } }),
		).toBe("rate_limited");
		expect(kindOf("vertex", 503, { error: { status: "UNAVAILABLE" } })).toBe(
			"overloaded",
		);
		expect(
			kindOf("vertex", 400, { error: { status: "INVALID_ARGUMENT" } }),
		).toBe("bad_request");
		expect(kindOf("vertex", 500, { error: { status: "INTERNAL" } })).toBe(
			"server",
		);
	});

	test("azure content_filter code", () => {
		expect(
			kindOf("azure-openai", 400, {
				error: { code: "content_filter", message: "filtered" },
			}),
		).toBe("bad_request");
	});
});

describe("retry-after", () => {
	test("header delta-seconds and HTTP-date forms, header wins", () => {
		const r = normalizeUpstreamError(
			"openai-compat",
			429,
			{ error: { metadata: { retry_after: 3 } } },
			new Headers({ "retry-after": "7" }),
		);
		expect(r.retryAfterS).toBe(7);
	});

	test("body error.metadata.retry_after when no header", () => {
		const r = normalizeUpstreamError("openai-compat", 429, {
			error: { metadata: { retry_after: "3" } },
		});
		expect(r.retryAfterS).toBe(3);
		expect(r.retryable).toBe(true);
	});
});

describe("networkFromThrow", () => {
	test("abort vs fetch failure", () => {
		const aborted = networkFromThrow(new Error("aborted"), AbortSignal.abort());
		expect(aborted.kind).toBe("timeout");
		const timeoutErr = new Error("timed out");
		timeoutErr.name = "TimeoutError";
		expect(networkFromThrow(timeoutErr).kind).toBe("timeout");
		expect(networkFromThrow(new TypeError("fetch failed")).kind).toBe(
			"network",
		);
	});
});
