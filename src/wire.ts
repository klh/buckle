// src/wire.ts — upstream request construction. The request body is the one
// thing the router rewrites (model alias patch + stream_options injection);
// responses are never re-serialized (see handlers.ts). Semantics ported from
// LiteLLM 1.103.0 (MIT): stream_options.include_usage injected toward
// openai-dialect upstreams so usage arrives on the terminal chunk — the
// caller-visible effect is what include_usage controls, and the router's
// usage accounting must not depend on what the caller asked for.
import type { Deployment } from "./upstreams.ts";
import type { UpstreamRequest } from "./router.ts";

/** The rewritten upstream body for a candidate deployment. */
export function buildUpstreamBody(
	dep: Deployment,
	req: UpstreamRequest,
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		...req.body,
		model: dep.model ?? req.body.model,
	};
	if (dep.dialect === "openai" && body.stream === true) {
		const prior = (body.stream_options ?? {}) as Record<string, unknown>;
		body.stream_options = { ...prior, include_usage: true };
	}
	return body;
}

/** Default upstream transport: fetch with timeout + caller-signal abort. */
export function defaultFetch(
	dep: Deployment,
	req: UpstreamRequest,
	timeoutMs: number,
): Promise<Response> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (dep.api_key_env) {
		const token = process.env[dep.api_key_env];
		if (token) headers.authorization = `Bearer ${token}`;
	}
	const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
	if (req.signal) signals.push(req.signal);
	return fetch(new URL(req.path, dep.url), {
		method: "POST",
		headers,
		body: JSON.stringify(buildUpstreamBody(dep, req)),
		signal: AbortSignal.any(signals),
	});
}
