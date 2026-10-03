// src/handlers.ts — wire handlers: the two ingress dialects (POST
// /v1/chat/completions openai-shape, POST /v1/messages anthropic-shape) plus
// /v1/messages/count_tokens and GET /v1/models. SSE responses pass through
// byte-identical (tee, never re-serialized); usage is sniffed from the
// terminal events per the W129 contract (streaming_handler.py semantics,
// MIT port). Errors follow the ingress dialect's error shape; unknown-usage
// streams record requests without token columns — honest omission, never
// estimated.

import type { AidsLedger } from "./aids.ts";
import { aidsRoutes, applyWireAids } from "./aids-routes.ts";
import type { RepoPolicyRow } from "./repo-policy.ts";
import { repoPolicyRoutes } from "./repo-policy-routes.ts";
import type { CandidateRow, CandidateTable } from "./candidates.ts";
import type { Expander } from "./expand.ts";
import {
	allowOf,
	lanePrefixOf,
	methodNotAllowed,
	options204,
	PROBLEM_SLUGS,
	problem,
} from "./citizenship.ts";
import { scoreComplexity, textFromMessages } from "./complexity.ts";
import {
	type DecideResult,
	type DecisionKind,
	latencyClass,
	type RouteSelection,
} from "./decide.ts";
import { type Federation, principalOf } from "./gov/federation.ts";
import { hintFromHeaders, type RouteHint } from "./hints.ts";
import { keyIdFromAuth, type Ledger } from "./ledger.ts";
import type { AidsPolicy } from "./policy.ts";
import type { Preseeder } from "./preseed.ts";
import { pipelineRoutes, type CondenseStore } from "./pipeline.ts";
import { condenseInbound } from "./pipeline-wire.ts";
import { type ExecuteResult, type Router, UpstreamError } from "./router.ts";
import type { Servicemon } from "./servicemon.ts";
import { SseSniffer } from "./sse.ts";
import type { Dialect, UpstreamPool } from "./upstreams.ts";
import { type Usage, usageFromAnthropic, usageFromOpenAI } from "./usage.ts";

export interface AppDeps {
	router: Router;
	ledger: Ledger;
	sm: Servicemon;
	pool: UpstreamPool;
	// W140: the pure decision over the candidate table + the table itself
	// (EWMA outcomes, in-flight load)
	decide: (input: {
		group: string;
		dialect: Dialect;
		hint: RouteHint | null;
		hintRaw: string;
	}) => DecideResult;
	table: CandidateTable;
	// W142 knowledge aids: the metering ledger, the preseed builder, and the
	// policy slice that gates them (routing-policy.yaml `aids:` block)
	aids: AidsLedger;
	preseeder: Preseeder;
	aidsPolicy: AidsPolicy;
	// W4 intent expansion — optional so bare deps (testDeps, dev) skip the
	// expand aid honestly instead of failing the wire path.
	expander?: Expander;
	// W5 prompt pipeline IN: the condense sidestore (pipeline.ts). Optional —
	// bare deps (testDeps, dev) skip honestly and the routes 404 (AppDeps law).
	pipeline?: CondenseStore;
	// W154 federation surface — present on hub-shaped deps (buildDeps);
	// optional so bare deps (testDeps, dev) 404 honestly.
	federation?: Federation;
	// W7 repo-policy gate: the loaded rows (absent/empty = engine inert);
	// the route 404s honestly when unwired.
	repoPolicy?: RepoPolicyRow[];
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

/** Short request id — the audit join key echoed as x-belt-rid. */
function newRid(): string {
	return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const HEADERS_JSON = (h: Record<string, string>): Headers => {
	const out = new Headers();
	for (const [k, v] of Object.entries(h)) out.set(k, v);
	return out;
};

/** Stamp the W136 wire headers on a response without touching its body:
 *  x-belt-rid always; x-belt-route (single-line JSON: rid, target, decision,
 *  latency_class, tier) on every router-decided response; x-belt-error on
 *  errors. */
function stamped(
	resp: Response,
	ctx: Ctx,
	route: { decision: string; row?: CandidateRow; code?: string | null },
): Response {
	const payload: Record<string, unknown> = {
		rid: ctx.rid,
		decision: route.decision,
	};
	if (route.row) {
		payload.target = {
			kind: route.row.kind,
			host: route.row.host,
			port: route.row.port,
			model: route.row.model,
		};
		payload.latency_class = latencyClass(route.row.estimate_ms);
	}
	if (ctx.tier) payload.tier = ctx.tier;
	if (ctx.lane) payload.lane = ctx.lane;
	const hs = HEADERS_JSON({
		"x-belt-rid": ctx.rid,
		"x-belt-route": JSON.stringify(payload),
		...(route.code ? { "x-belt-error": route.code } : {}),
	});
	for (const [k, v] of hs) resp.headers.set(k, v);
	return resp;
}

/** Buckle-GENERATED error body: problem+json with the stable code in `code`
 *  (http-citizenship). Two documented exceptions: upstream pass-through
 *  errors ride the upstream's body verbatim (client-error), and mid-stream
 *  failures speak SSE (the status is already sent). */
export function errorResponse(
	status: number,
	why: string,
	code?: string | null,
): Response {
	return problem({
		status,
		code: code ?? `buckle.${PROBLEM_SLUGS[status] ?? "problem"}`,
		why: code ? `belt: ${code} — ${scrubText(why)}` : scrubText(why),
	});
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
	rid: string;
	/** W1 lane attribution: the /w/<slug> slug ('' on bare paths). */
	lane: string;
	hintRaw: string;
	hint: RouteHint | null;
	tier: string;
	t0: number;
	sel?: RouteSelection;
	/** W5: the request declared `condense-in` in its x-belt-aids stanza. */
	condenseIn: boolean;
}

/** A refusal at the wire seam (bad hint, bad body): the denied audit row
 *  (denied audits too — W136 §6). */
function deny(
	deps: AppDeps,
	ctx: Ctx,
	status: number,
	why: string,
	code: string | null,
	decision: "denied" | "errored",
): Response {
	deps.ledger.auditDecision({
		rid: ctx.rid,
		ts: new Date().toISOString(),
		actor: ctx.key,
		lane: ctx.lane,
		dialect: ctx.dialect,
		hint: ctx.hintRaw,
		candidates_seen: 0,
		candidates_top: "",
		target_kind: null,
		target_host: null,
		target_port: null,
		target_model: null,
		decision,
		latency_class: "unproven",
		tier: ctx.tier,
		allow_cloud: false,
		error_code: code,
		why,
	});
	return auditAndStamp(deps, ctx, status, why, code, decision);
}

/** Outcome row + dialect envelope + stamped headers for a refusal. */
function auditAndStamp(
	deps: AppDeps,
	ctx: Ctx,
	status: number,
	why: string,
	code: string | null,
	decision: "denied" | "errored",
): Response {
	deps.ledger.auditOutcome(ctx.rid, {
		status,
		duration_ms: Date.now() - ctx.t0,
		ok: false,
		err: why,
	});
	const resp = errorResponse(status, why, code);
	return stamped(resp, ctx, { decision, code });
}

async function proxy(
	req: Request,
	dialect: Dialect,
	path: string,
	deps: AppDeps,
	lane = "",
): Promise<Response> {
	const ctx: Ctx = {
		key: keyIdFromAuth(req.headers.get("authorization")),
		group: "",
		model: "",
		dialect,
		rid: newRid(),
		lane,
		hintRaw: "",
		hint: null,
		t0: 0,
		tier: "",
		condenseIn: false,
	};
	ctx.t0 = Date.now();
	const hint = hintFromHeaders(req.headers);
	if (!hint.ok) return deny(deps, ctx, 400, hint.why, "bad_hint", "denied");
	let body: Record<string, unknown>;
	try {
		body = (await req.json()) as Record<string, unknown>;
	} catch {
		return deny(deps, ctx, 400, "invalid JSON body", null, "denied");
	}
	const model = typeof body.model === "string" ? body.model : "";
	if (model.length === 0)
		return deny(deps, ctx, 400, "missing model", null, "denied");
	const wire = await applyWireAids(
		deps,
		req.headers.get("x-belt-aids"),
		body,
		dialect,
	);
	body = wire.body;
	ctx.condenseIn = wire.condenseIn;
	ctx.group = model;
	ctx.model = model;
	ctx.hint = hint.hint;
	ctx.hintRaw = hint.raw;
	ctx.tier = scoreComplexity(textFromMessages(body.messages)).tier;
	const sel = deps.decide({
		group: model,
		dialect,
		hint: ctx.hint,
		hintRaw: ctx.hintRaw,
	});
	if (!sel.ok) {
		deps.sm
			.counter("buckle_route_decisions_total", "Routing decisions.")
			.inc({ decision: "errored", dialect });
		return deny(deps, ctx, 503, sel.err.why, sel.err.code, "errored");
	}
	ctx.sel = sel.sel;
	return runExecute(req, ctx, path, body, deps);
}

async function runExecute(
	req: Request,
	ctx: Ctx,
	path: string,
	body: Record<string, unknown>,
	deps: AppDeps,
): Promise<Response> {
	const sel = ctx.sel;
	if (!sel) return deny(deps, ctx, 503, "no selection", "no_route", "errored");
	deps.ledger.auditDecision({
		rid: ctx.rid,
		ts: new Date().toISOString(),
		actor: ctx.key,
		lane: ctx.lane,
		dialect: ctx.dialect,
		hint: ctx.hintRaw,
		candidates_seen: sel.seen,
		candidates_top: sel.top.join(","),
		target_kind: sel.head.kind,
		target_host: sel.head.host,
		target_port: sel.head.port,
		target_model: sel.head.model,
		decision: sel.decision,
		latency_class: latencyClass(sel.head.estimate_ms),
		tier: ctx.tier,
		allow_cloud: sel.prefs.allow_cloud,
		error_code: null,
		why: sel.why,
	});
	deps.table.inflight(sel.head.candidate_id, 1);
	let result: ExecuteResult;
	try {
		result = await deps.router.execute({
			group: ctx.model,
			dialect: ctx.dialect,
			path,
			body,
			key: ctx.key,
			signal: req.signal,
			sel,
			tier: ctx.tier,
			hintRaw: ctx.hintRaw,
		});
	} catch (e) {
		deps.table.inflight(sel.head.candidate_id, -1);
		if (e instanceof UpstreamError)
			return deny(deps, ctx, 502, e.message, "no_route", "errored");
		throw e;
	}
	const resp = await handleResult(deps, ctx, result);
	return finishResponse(deps, ctx, sel, result, resp);
}

/** Stamps the delivered outcome onto the response + audit + EWMA.
 *  Delivered ≠ selected → decision "fallback" (delivery truth outranks
 *  ranking truth; W136 §7.6). */
function finishResponse(
	deps: AppDeps,
	ctx: Ctx,
	sel: RouteSelection,
	result: ExecuteResult,
	resp: Response,
): Response {
	let decision: DecisionKind = sel.decision;
	let row: CandidateRow | undefined = sel.head;
	let code: string | null = null;
	if (result.kind === "upstream") {
		row = deps.table.rowFor(result.candidateId) ?? sel.head;
		if (result.candidateId !== sel.head.candidate_id) decision = "fallback";
	} else if (result.kind === "exhausted") {
		decision = "errored";
		code = "no_route";
	} else if (result.kind === "aborted") {
		decision = "errored";
	}
	const ms = Date.now() - ctx.t0;
	const ok = result.kind === "upstream" || result.kind === "client-error";
	deps.table.inflight(sel.head.candidate_id, -1);
	const winner =
		result.kind === "upstream" ? result.candidateId : sel.head.candidate_id;
	deps.table.recordOutcome(winner, ms, result.kind === "upstream");
	deps.ledger.auditOutcome(ctx.rid, {
		status: resp.status,
		duration_ms: ms,
		ok,
		err: result.kind === "exhausted" ? result.error : null,
	});
	deps.sm
		.counter("buckle_route_decisions_total", "Routing decisions.")
		.inc({ decision, dialect: ctx.dialect });
	return stamped(resp, ctx, { decision, row, code });
}

function handleResult(
	deps: AppDeps,
	ctx: Ctx,
	result: ExecuteResult,
): Response | Promise<Response> {
	if (result.kind === "aborted") return new Response(null, { status: 499 });
	if (result.kind === "exhausted") {
		return errorResponse(502, result.error, "no_route");
	}
	if (result.kind === "client-error") {
		// the upstream rejected the request — its error body is the most
		// informative answer for the client; no ledger row (nothing proxied).
		// A 429 is the UPSTREAM's budget, never buckle's: its limit headers
		// ride renamed x-upstream-ratelimit-* so clients never confuse whose
		// budget fired (proxy precedence law).
		const headers = SSE_HEADERS(result.response.headers);
		if (result.response.status === 429) {
			for (const [k, v] of result.response.headers) {
				const lk = k.toLowerCase();
				if (!lk.startsWith("x-ratelimit-") && !lk.startsWith("ratelimit-"))
					continue;
				headers.set(
					`x-upstream-ratelimit-${lk.replace(/^(x-)?ratelimit-/, "")}`,
					v,
				);
			}
		}
		return new Response(result.response.body, {
			status: result.response.status,
			headers,
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
	// W5 inbound condense: sidestore AFTER the ledger row; the response
	// bytes above are untouched (byte identity).
	condenseInbound(deps, ctx, parsed);
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
		const method = req.method;
		// http-citizenship: introspection from the one route table (the gate
		// answers pre-auth when enabled; this covers BUCKLE_AUTH=off + tests).
		if (method === "OPTIONS") {
			const allow = allowOf(path);
			if (allow !== null) return options204(allow);
		}
		// W1 lane attribution (caveman adopt 1): /w/<slug> prefixes the LLM
		// ingress + /v1/models only. The slug lands in the audit row + the
		// x-belt-route header; the upstream sees the bare path. Other
		// surfaces (federation/admin/aids) stay unprefixed — a lane prefix
		// never widens surface.
		const laneRoute = lanePrefixOf(path);
		if (laneRoute.lane !== "") {
			const inner = laneRoute.path;
			const ingress =
				inner === "/v1/chat/completions" ||
				inner === "/v1/messages" ||
				inner === "/v1/messages/count_tokens" ||
				inner === "/v1/models";
			if (method === "OPTIONS" && ingress)
				return options204(allowOf(inner) ?? "OPTIONS");
			if (method === "GET" && inner === "/v1/models") return models(deps);
			if (method === "POST" && inner === "/v1/chat/completions")
				return proxy(req, "openai", inner, deps, laneRoute.lane);
			if (method === "POST" && inner === "/v1/messages/count_tokens")
				return proxy(req, "anthropic", inner, deps, laneRoute.lane);
			if (method === "POST" && inner === "/v1/messages")
				return proxy(req, "anthropic", inner, deps, laneRoute.lane);
			if (ingress) return methodNotAllowed(inner);
			return problem({
				status: 404,
				code: "buckle.no_route",
				why: `no route: ${method} ${path}`,
			});
		}
		if (method === "GET" && path === "/v1/models") return models(deps);
		if (method === "GET" && path === "/health") {
			return new Response("ok", { headers: { "content-type": "text/plain" } });
		}

		if (method === "GET" && path === "/.well-known/jwks.json") {
			// W193: public JWKS — spokes fetch the manifest-signing public key
			// pre-cred; bare deps 404 honestly (the AppDeps contract).
			if (!deps.federation?.signer)
				return problem({
					status: 404,
					code: "buckle.no_route",
					why: `no route: ${method} ${path}`,
				});
			return Response.json(deps.federation.signer.jwks());
		}
		if (path.startsWith("/federation")) {
			// bare deps 404 honestly (the AppDeps contract)
			if (!deps.federation)
				return problem({
					status: 404,
					code: "buckle.no_route",
					why: `no route: ${method} ${path}`,
				});
			return deps.federation.handle(req, principalOf(req));
		}
		const aidsRouted = await aidsRoutes(deps, req, path);
		if (aidsRouted) return aidsRouted;
		const pipeRouted = await pipelineRoutes(deps, req, path);
		if (pipeRouted) return pipeRouted;
		const rpRouted = await repoPolicyRoutes(
			{ rows: deps.repoPolicy ?? [], sm: deps.sm },
			req,
			path,
		);
		if (rpRouted) return rpRouted;
		if (method === "POST" && path === "/v1/chat/completions") {
			return proxy(req, "openai", path, deps);
		}
		if (method === "POST" && path === "/v1/messages/count_tokens") {
			return proxy(req, "anthropic", path, deps);
		}
		if (method === "POST" && path === "/v1/messages") {
			return proxy(req, "anthropic", path, deps);
		}
		// known path, wrong method → 405 + Allow (admin paths stay 404 here —
		// the gate routes them post-auth, where handleAdmin answers 405).
		if (allowOf(path) !== null && !path.startsWith("/v1/admin")) {
			return methodNotAllowed(path);
		}
		return problem({
			status: 404,
			code: "buckle.no_route",
			why: `no route: ${method} ${path}`,
		});
	}
	return { fetch };
}

function models(deps: AppDeps): Response {
	const data = deps.pool
		.groups()
		.map((id) => ({ id, object: "model", owned_by: "buckle" }));
	return Response.json({ object: "list", data });
}
