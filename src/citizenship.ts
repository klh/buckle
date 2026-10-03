// src/citizenship.ts — the http-citizenship standard's shared seams
// (docs/design/http-citizenship.md, W155): problem+json bodies carrying the
// stable buckle.* code in `code`, method introspection (OPTIONS 204, 405 +
// Allow) off ONE route table, and the rate-limit header trio in both
// families. The gate (gov/middleware.ts), the wire handlers, the admin API
// and servicemon all code to this module — one source of truth per pattern.

export const PROBLEM_SLUGS: Record<number, string> = {
	400: "bad_request",
	401: "authentication_error",
	403: "permission_error",
	404: "not_found",
	405: "method_not_allowed",
	409: "state_conflict",
	422: "invalid_request",
	429: "rate_limit_error",
	500: "internal_error",
	502: "upstream_error",
	503: "service_unavailable",
	504: "upstream_timeout",
};

const TITLES: Record<number, string> = {
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	409: "Conflict",
	422: "Unprocessable Content",
	429: "Too Many Requests",
	500: "Internal Server Error",
	502: "Bad Gateway",
	503: "Service Unavailable",
	504: "Gateway Timeout",
};

export interface ProblemInput {
	status: number;
	/** Stable machine code — buckle.* for the gate/admin family, the W140
	 *  route codes (bad_hint, no_healthy_fit, cloud_forbidden, no_route)
	 *  for router refusals. Never renamed, only added to. */
	code: string;
	why: string;
	instance?: string;
	next?: string[];
	challenge?: string;
	headers?: Record<string, string>;
}

/** RFC 9457 problem+json with the fleet extensions: `code` (stable machine
 *  code), `why` (human detail), `agent_next_steps` (machine-actionable
 *  recovery). Curated strings only — internals never leak. */
export function problem(p: ProblemInput): Response {
	const body = {
		type: `/problems/${PROBLEM_SLUGS[p.status] ?? "problem"}`,
		title: TITLES[p.status] ?? "Problem",
		status: p.status,
		detail: p.why,
		...(p.instance === undefined ? {} : { instance: p.instance }),
		code: p.code,
		why: p.why,
		...(p.next === undefined ? {} : { agent_next_steps: p.next }),
	};
	const h = new Headers({
		"content-type": "application/problem+json",
		...(p.challenge === undefined ? {} : { "www-authenticate": p.challenge }),
	});
	for (const [k, v] of Object.entries(p.headers ?? {})) h.set(k, v);
	return new Response(JSON.stringify(body), { status: p.status, headers: h });
}

/** The wire route table: path → Allow value. null = unknown path (404).
 *  /status and /metrics live here too even though servicemon serves them
 *  outside the gate — the table is the one truth about what exists. */
export function allowOf(path: string): string | null {
	if (path === "/health" || path === "/v1/models") return "GET, HEAD, OPTIONS";
	if (path === "/status" || path === "/metrics") return "GET, HEAD, OPTIONS";
	if (path === "/.well-known/jwks.json") return "GET, HEAD, OPTIONS";
	if (
		path === "/v1/chat/completions" ||
		path === "/v1/messages" ||
		path === "/v1/messages/count_tokens" ||
		path === "/aids/preseed"
	)
		return "POST, OPTIONS";
	if (
		path === "/aids/status" ||
		path === "/aids/rollup" ||
		path === "/aids/events" ||
		path === "/pipeline/in" ||
		/^\/pipeline\/in\/\S+$/.test(path)
	)
		return "GET, HEAD, OPTIONS";
	if (path === "/v1/admin/keys" || path === "/v1/admin/teams")
		return "GET, POST, OPTIONS";
	if (
		path === "/v1/admin/keys/verify" ||
		path === "/v1/admin/budgets/flush" ||
		/^\/v1\/admin\/keys\/[0-9a-f]{12}\/revoke$/.test(path)
	)
		return "POST, OPTIONS";
	if (path === "/v1/admin/budgets") return "GET, HEAD, OPTIONS";
	if (path === "/federation" || path.startsWith("/federation/"))
		return "GET, POST, OPTIONS";
	return null;
}

/** OPTIONS → 204 + Allow (CORS preflights never carry credentials, so the
 *  gate answers these pre-auth). */
export function options204(allow: string): Response {
	return new Response(null, { status: 204, headers: { allow } });
}

/** Known path, wrong method → 405 + Allow, problem+json body. */
export function methodNotAllowed(path: string): Response {
	const allow = allowOf(path) ?? "OPTIONS";
	return problem({
		status: 405,
		code: "buckle.method_not_allowed",
		why: `allows: ${allow}`,
		instance: path,
		headers: { allow },
	});
}

export interface RateLimitView {
	limit: number;
	remaining: number;
	/** Seconds until the minute window rolls (IETF draft Reset). */
	resetS: number;
	/** Unix epoch seconds of the window's end (de-facto x- family Reset). */
	resetEpochS: number;
	/** RateLimit-Policy value: the govdb budget name + quota. */
	policy: string;
}

/** Both header families, always together — RateLimit-* (IETF draft, Reset =
 *  seconds) and x-ratelimit-* (de-facto, Reset = epoch of window end). */
export function stampRateLimit(h: Headers, v: RateLimitView): void {
	const limit = String(v.limit);
	const remaining = String(Math.max(0, v.remaining));
	h.set("ratelimit-limit", limit);
	h.set("ratelimit-remaining", remaining);
	h.set("ratelimit-reset", String(v.resetS));
	h.set("ratelimit-policy", v.policy);
	h.set("x-ratelimit-limit", limit);
	h.set("x-ratelimit-remaining", remaining);
	h.set("x-ratelimit-reset", String(v.resetEpochS));
}
