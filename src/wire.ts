// src/wire.ts — upstream request construction, now through the adapter
// registry (W134 §4.1): the deployment's family adapter builds the wire
// call (model alias patch + dialect patches + auth); responses are never
// re-serialized (see handlers.ts). The openai-compat adapter reproduces
// the pre-adapter body byte-for-byte (model patch + stream_options
// .include_usage injection; LiteLLM streaming_handler.py semantics, MIT) —
// the 37-test regression net pins the bytes.
import { resolveAdapter } from "./adapters/index.ts";
import type { Deployment } from "./upstreams.ts";
import type { UpstreamRequest } from "./router.ts";

/** Default upstream transport: adapter-built wire call + fetch with
 *  timeout + caller-signal abort. */
export async function defaultFetch(
	dep: Deployment,
	req: UpstreamRequest,
	timeoutMs: number,
): Promise<Response> {
	const adapter = resolveAdapter(dep);
	const wire = await adapter.buildCall(dep, req, req.body);
	const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
	if (req.signal) signals.push(req.signal);
	return fetch(wire.url, {
		method: "POST",
		headers: wire.headers,
		body: wire.body,
		signal: AbortSignal.any(signals),
	});
}
