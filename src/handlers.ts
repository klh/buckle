// src/handlers.ts — wire handlers: the two ingress dialects (POST
// /v1/chat/completions openai-shape, POST /v1/messages anthropic-shape) plus
// /v1/messages/count_tokens and GET /v1/models. SSE responses pass through
// byte-identical (tee, never re-serialized); usage is sniffed from the
// terminal events per the W129 contract (streaming_handler.py semantics,
// MIT port). Errors follow the ingress dialect's error shape; unknown-usage
// streams record requests without token columns — honest omission, never
// estimated.
import { type Ledger, keyIdFromAuth } from "./ledger.ts";
import { UpstreamError, type ExecuteResult, type Router } from "./router.ts";
import { SseSniffer } from "./sse.ts";
import type { Servicemon } from "./servicemon.ts";
import type { Dialect, UpstreamPool } from "./upstreams.ts";
import { usageFromAnthropic, usageFromOpenAI, type Usage } from "./usage.ts";

export interface AppDeps {
	router: Router;
	ledger: Ledger;
	sm: Servicemon;
	pool: UpstreamPool;
}

interface App {
	fetch(req: Request): Promise<Response>;
}

const SSE_HEADERS = (h: Headers): Headers => {
	const out = new Headers();
	for (const [k, v] of h) {
		if (
			k === "content-length" ||
			k === "transfer-encoding" ||
			k === "connection"
		)
			continue;
		out.set(k, v);
	}
	return out;
};

const enc = new TextEncoder();

/** Error body per ingress dialect (anthropic envelope vs openai error obj). */
export function errorResponse(
	dialect: Dialect,
	status: number,
	message: string,
): Response {
	const scrubbed = scrubText(message);
	if (dialect === "anthropic") {
		return Response.json(
			{
				type: "error",
				error: { type: "api_error", message: scrubbed },
			},
			{ status },
		);
	}
	return Response.json(
		{ error: { message: scrubbed, type: "api_error", code: "upstream_error" } },
		{ status },
	);
}

/** /Users/<name> paths and key material never leave through an error. */
export function scrubText(text: string): string {
	return text.replace(/\/Users\/[^/\s'"]+/g, "~");
}

interface Ctx {
	key: string;
	group: string;
	model: string;
	dialect: Dialect;
}

async function proxy(
	req: Request,
	dialect: Dialect,
	path: string,
	deps: AppDeps,
): Promise<Response> {
	let body: Record<string, unknown>;
	try {
		body = (await req.json()) as Record<string, unknown>;
	} catch {
		return errorResponse(dialect, 400, "invalid JSON body");
	}
	const model = typeof body.model === "string" ? body.model : "";
	if (model.length === 0) {
		return errorResponse(dialect, 400, "missing model");
	}
	const ctx: Ctx = {
		key: keyIdFromAuth(req.headers.get("authorization")),
		group: model,
		model,
		dialect,
	};
	return runExecute(req, ctx, path, body, deps);
}

async function runExecute(
	req: Request,
	ctx: Ctx,
	path: string,
	body: Record<string, unknown>,
	deps: AppDeps,
): Promise<Response> {
	let result: ExecuteResult;
	try {
		result = await deps.router.execute({
			group: ctx.model,
			dialect: ctx.dialect,
			path,
			body,
			key: ctx.key,
			signal: req.signal,
		});
	} catch (e) {
		if (e instanceof UpstreamError)
			return errorResponse(ctx.dialect, 502, e.message);
		throw e;
	}
	return handleResult(deps, ctx, result);
}

function handleResult(
	deps: AppDeps,
	ctx: Ctx,
	result: ExecuteResult,
): Response | Promise<Response> {
	if (result.kind === "aborted") return new Response(null, { status: 499 });
	if (result.kind === "exhausted") {
		return errorResponse(ctx.dialect, 502, result.error);
	}
	if (result.kind === "client-error") {
		// the upstream rejected the request — its error body is the most
		// informative answer for the client; no ledger row (nothing proxied)
		return new Response(result.response.body, {
			status: result.response.status,
			headers: SSE_HEADERS(result.response.headers),
		});
	}
	if (!result.stream) return jsonResponse(deps, ctx, result);
	return streamResponse(deps, ctx, result);
}

async function jsonResponse(
	deps: AppDeps,
	ctx: Ctx,
	result: Extract<ExecuteResult, { kind: "upstream" }>,
): Promise<Response> {
	const raw = new Uint8Array(await result.response.arrayBuffer());
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(new TextDecoder().decode(raw));
	} catch {
		// unparseable ok-body: record the request, no usage columns
	}
	let usage: Usage | null = null;
	if (parsed !== null && typeof parsed === "object") {
		const u = (parsed as Record<string, unknown>).usage;
		usage =
			ctx.dialect === "anthropic" ? usageFromAnthropic(u) : usageFromOpenAI(u);
	}
	record(deps, ctx, usage);
	return new Response(raw, {
		status: result.response.status,
		headers: SSE_HEADERS(result.response.headers),
	});
}

/** SSE pass-through with the usage-only tee: one branch flows to the client
 *  through an identity TransformStream (byte identity), the other feeds the
 *  sniffer into a black hole. No re-route after first byte; an upstream
 *  death mid-stream appends a dialect error event and closes. */
function streamResponse(
	deps: AppDeps,
	ctx: Ctx,
	result: Extract<ExecuteResult, { kind: "upstream" }>,
): Response | Promise<Response> {
	const upstream = result.response;
	if (!upstream.body) return jsonResponse(deps, ctx, result);
	const sniffer = new SseSniffer(ctx.dialect);
	const [sniffBranch, clientBranch] = upstream.body.tee();
	const downstream = new TransformStream<Uint8Array, Uint8Array>();
	const finish = once(() => {
		sniffer.flush();
		record(deps, ctx, sniffer.usage());
	});
	sniffBranch.pipeTo(blackHole(sniffer)).catch(() => {
		// the sniff branch failing must not affect the client branch
	});
	clientBranch.pipeTo(downstream.writable).then(finish, (err: unknown) => {
		finish();
		writeErrorEvent(downstream.writable, ctx.dialect, err);
	});
	return new Response(downstream.readable, {
		status: 200,
		headers: SSE_HEADERS(upstream.headers),
	});
}

/** Sink for the sniff branch: bytes in, usage extraction, nothing out. */
function blackHole(sniffer: SseSniffer): WritableStream<Uint8Array> {
	return new WritableStream({
		write(chunk) {
			sniffer.push(chunk);
		},
	});
}

/** Run fn once; later callers are no-ops (stream finalization guard). */
function once(fn: () => void): () => void {
	let called = false;
	return () => {
		if (called) return;
		called = true;
		fn();
	};
}

/** Mid-stream upstream death: append a dialect error event, close. */
function writeErrorEvent(
	writable: WritableStream<Uint8Array>,
	dialect: Dialect,
	err: unknown,
): void {
	const message = scrubText(
		err instanceof Error ? err.message : "upstream stream failed",
	);
	const w = writable.getWriter();
	const body =
		dialect === "anthropic"
			? `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`
			: `data: ${JSON.stringify({ error: { message, type: "api_error", code: "stream_failed" } })}\n\n`;
	void w
		.write(enc.encode(body))
		.then(() => w.close())
		.catch(() => {
			// client already gone — nothing to write to
		});
}

/** One completed proxied request → ledger row + servicemon token counters.
 *  usage null = honest unknown: the requests column still increments, token
 *  columns contribute nothing, servicemon gets an explicit counter. */
function record(deps: AppDeps, ctx: Ctx, usage: Usage | null): void {
	if (usage === null) {
		// honest unknown: count the request, contribute no token columns,
		// flag it on servicemon — never estimated, never faked as real zeros
		deps.sm
			.counter(
				"buckle_usage_unknown_total",
				"Proxied responses where usage could not be observed.",
			)
			.inc();
		deps.ledger.record({
			key: ctx.key,
			group: ctx.group,
			model: ctx.model,
			in_tok: 0,
			out_tok: 0,
			cache_r: 0,
			cache_c: 0,
			requests: 1,
		});
		return;
	}
	deps.ledger.record({
		key: ctx.key,
		group: ctx.group,
		model: ctx.model,
		in_tok: usage.in_tok,
		out_tok: usage.out_tok,
		cache_r: usage.cache_r,
		cache_c: usage.cache_c,
		requests: 1,
	});
	deps.sm.tokens("in", usage.in_tok);
	deps.sm.tokens("out", usage.out_tok);
	deps.sm.tokens("cache_read", usage.cache_r);
	deps.sm.tokens("cache_create", usage.cache_c);
}

/** Route dispatch; servicemon instruments at the server seam. */
export function createApp(deps: AppDeps): App {
	async function fetch(req: Request): Promise<Response> {
		const path = new URL(req.url).pathname;
		if (req.method === "GET" && path === "/v1/models") return models(deps);
		if (req.method === "GET" && path === "/health") {
			return new Response("ok", { headers: { "content-type": "text/plain" } });
		}
		if (req.method === "POST" && path === "/v1/chat/completions") {
			return proxy(req, "openai", path, deps);
		}
		if (req.method === "POST" && path === "/v1/messages/count_tokens") {
			return proxy(req, "anthropic", path, deps);
		}
		if (req.method === "POST" && path === "/v1/messages") {
			return proxy(req, "anthropic", path, deps);
		}
		return errorResponse("openai", 404, `no route: ${req.method} ${path}`);
	}
	return { fetch };
}

function models(deps: AppDeps): Response {
	const data = deps.pool
		.groups()
		.map((id) => ({ id, object: "model", owned_by: "buckle" }));
	return Response.json({ object: "list", data });
}
