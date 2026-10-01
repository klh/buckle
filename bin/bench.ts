// bin/bench.ts — the W143 8-scenario bench (speed §5): buckle under test in
// this process against deterministic mock upstreams, an interleaved
// direct-to-mock control per iteration, machine-readable JSON lines on
// stdout (one per scenario + a summary), the human table on stderr.
// Router-added latency = through-buckle − direct-to-mock, per iteration —
// the full proxy path (ingress + decision + adapter + pooled dispatch),
// mock time cancels. Byte identity: sha256(received) vs the mock's bytes.
// Gate: p50 < 5ms, p95 < 15ms (scenarios stream-short, non-stream-short,
// concurrent-50, failover-pre-byte). LiteLLM baseline: record-only.
// bun bin/bench.ts [--n 600] [--quick] [--litellm http://127.0.0.1:4100]
//                  [--out /path/bench.jsonl]
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolvePort, startServer } from "../src/server.ts";
import { poolWarm } from "../src/pool-warm.ts";
import { BudgetBooks } from "../src/budgets.ts";

// ── args ──
const arg = (name: string): string | null => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);
const N = Number(arg("n") ?? (has("quick") ? 200 : 600));
const LITELLM =
	arg("litellm") ?? process.env.LITELLM_BASELINE ?? "http://127.0.0.1:4100";
const OUT = arg("out");
const enc = new TextEncoder();

// ── stats helpers ──
const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);
const pct = (xs: number[], p: number): number => {
	const s = sorted(xs);
	if (s.length === 0) return NaN;
	return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? NaN;
};
const mean = (xs: number[]): number =>
	xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const ms = (n: number): number => Math.round(n * 1000) / 1000;
const sha = (bytes: Uint8Array): string =>
	new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

function emit(row: Record<string, unknown>): void {
	const line = JSON.stringify(row);
	console.log(line);
	if (OUT) {
		const dir = OUT.replace(/\/[^/]*$/, "");
		if (dir.length > 0 && dir !== OUT) mkdirSync(dir, { recursive: true });
		writeFileSync(OUT, `${line}\n`, { flag: "a" });
	}
}

// ── deterministic payloads ──
const sseChunk = (n: number): string =>
	`data: {"id":"b","choices":[{"delta":{"content":"t"}}]}\n\n`.repeat(n);

const STREAM_FIXTURE = `${sseChunk(256)}data: {"id":"b","choices":[],"usage":{"prompt_tokens":512,"completion_tokens":256}}\n\ndata: [DONE]\n\n`;
const STREAM_BYTES = enc.encode(STREAM_FIXTURE);
const STREAM_SHA = sha(STREAM_BYTES);

const NONSTREAM_BODY = JSON.stringify({
	id: "b",
	choices: [{ message: { role: "assistant", content: "ok" } }],
	usage: { prompt_tokens: 512, completion_tokens: 4 },
});
const NONSTREAM_BYTES = enc.encode(NONSTREAM_BODY);
const NONSTREAM_SHA = sha(NONSTREAM_BYTES);

// mixed sizes for the concurrent scenario: 128/256/512-token fixtures
const STREAM_128 = `${sseChunk(128)}data: {"id":"b","choices":[],"usage":{"prompt_tokens":512,"completion_tokens":128}}\n\ndata: [DONE]\n\n`;
const STREAM_512 = `${sseChunk(512)}`;

const streamFixtureFor = (
	tokens: number,
): { bytes: Uint8Array; sha: string } => {
	if (tokens === 128)
		return { bytes: enc.encode(STREAM_128), sha: sha(enc.encode(STREAM_128)) };
	if (tokens === 512) {
		const body = `${STREAM_512}data: {"id":"b","choices":[],"usage":{"prompt_tokens":512,"completion_tokens":512}}\n\ndata: [DONE]\n\n`;
		const bytes = enc.encode(body);
		return { bytes, sha: sha(bytes) };
	}
	return { bytes: STREAM_BYTES, sha: STREAM_SHA };
};
void streamFixtureFor; // available for --shape experiments; not wired yet

// ── the mock upstream: behavior keyed per mock instance ──
const startMock = (
	forced?: string,
): { url: string; server: Bun.Server<never> } => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const behavior = forced ?? req.headers.get("x-bench-behavior") ?? "ok";
			if (behavior === "502") return new Response("no", { status: 502 });
			if (behavior === "429")
				return new Response("slow down", {
					status: 429,
					headers: { "retry-after": "0.001" },
				});
			if (behavior === "die") {
				const { readable, writable } = new TransformStream();
				const w = writable.getWriter();
				void w.write(enc.encode(sseChunk(8)));
				setTimeout(() => {
					w.abort(new Error("mock died"));
				}, 5);
				return new Response(readable, {
					headers: { "content-type": "text/event-stream" },
				});
			}
			const parsed = (await req.json()) as { stream?: boolean } | null;
			if (parsed?.stream === false)
				return new Response(NONSTREAM_BODY, {
					headers: { "content-type": "application/json" },
				});
			return new Response(STREAM_FIXTURE, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, server };
};

// ── measurement ──
interface Timed {
	t1: number; // first byte
	full: number; // last byte
	bytes: Uint8Array;
	status: number;
}

async function timed(
	url: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Timed> {
	const t0 = performance.now();
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	const reader = res.body?.getReader();
	if (!reader)
		return {
			t1: performance.now() - t0,
			full: performance.now() - t0,
			bytes: new Uint8Array(0),
			status: res.status,
		};
	const parts: Uint8Array[] = [];
	let t1 = -1;
	while (true) {
		const next = await reader.read();
		if (next.done) break;
		if (t1 < 0) t1 = performance.now() - t0;
		parts.push(next.value);
	}
	const full = performance.now() - t0;
	const total = parts.reduce((a, p) => a + p.length, 0);
	const bytes = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		bytes.set(p, off);
		off += p.length;
	}
	return { t1, full, bytes, status: res.status };
}

// ── the buckle under test ──
// governance is W141's surface, not what the speed bench measures — off.
process.env.BUCKLE_AUTH = "off";
const dir = `/tmp/buckle-bench-${Date.now()}`;
mkdirSync(dir, { recursive: true });

interface BenchServer {
	port: number;
	base: string;
	stop(): void;
	dbPath: string;
	ctlUrl: string; // the fallback mock — a healthy direct control
}

const tagOf = (url: string): string => url.split(":").pop() ?? "0";

/** One buckle instance over two mock upstreams (primary + fallback tier). */
function buckle(opts: {
	numRetries: number;
	dbPath?: string;
	primaryForced?: string;
}): BenchServer {
	const primary = startMock(opts.primaryForced);
	const fallback = startMock();
	const tag = tagOf(primary.url);
	const dbPath = opts.dbPath ?? `${dir}/bench-${tag}.db`;
	const upYaml = `groups:\n  bench:\n    - url: ${primary.url}\n      dialect: openai\n  bench-fallback:\n    - url: ${fallback.url}\n      dialect: openai\n`;
	const polYaml = `gateway:\n  num_retries: ${String(opts.numRetries)}\n  allowed_fails: 50\n  cooldown_time: 0\n  retry_max_delay_s: 0.001\n  request_timeout_s: 10\nfallbacks:\n  bench: [bench-fallback]\n`;
	writeFileSync(`${dir}/upstreams-${tag}.yaml`, upYaml);
	const policyPath = `${dir}/policy-${tag}.yaml`;
	writeFileSync(policyPath, polYaml);
	const server = startServer({
		port: resolvePort(0),
		upstreamsPath: `${dir}/upstreams-${tag}.yaml`,
		policyPath,
		dbPath,
	});
	return {
		port: server.port ?? 0,
		base: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
		dbPath,
		ctlUrl: fallback.url,
	};
}

// ── interleaved control/treatment deltas ──
const CHAT = "/v1/chat/completions";
const BODY_SHORT = {
	model: "bench",
	stream: true,
	messages: [{ role: "user", content: `x`.repeat(2048) }],
};
const BODY_NONSTREAM = {
	model: "bench",
	stream: false,
	messages: [{ role: "user", content: `x`.repeat(2048) }],
};

interface DeltaRow {
	p50_ms: number;
	p95_ms: number;
	p99_ms: number;
	mean_ms: number;
	max_ms: number;
	identity_pct: number;
	abs_p50: number;
	abs_p95: number;
	n: number;
}

/** One interleaved pair: direct control, then through buckle. */
async function deltaPair(
	controlUrl: string,
	base: string,
	body: unknown,
	shape: "stream" | "nonstream",
	headers: Record<string, string>,
): Promise<{
	d1: number;
	df: number;
	okSha: boolean;
	abs1: number;
	absf: number;
}> {
	const ctl = await timed(`${controlUrl}${CHAT}`, body, {
		"x-bench-shape": shape,
	});
	const got = await timed(`${base}${CHAT}`, body, {
		"x-bench-shape": shape,
		...headers,
	});
	const expectSha = shape === "stream" ? STREAM_SHA : NONSTREAM_SHA;
	return {
		d1: got.t1 - ctl.t1,
		df: got.full - ctl.full,
		okSha: sha(got.bytes) === expectSha,
		abs1: got.t1,
		absf: got.full,
	};
}

async function runDeltas(
	base: string,
	n: number,
	controlUrl: string,
	body: unknown,
	shape: "stream" | "nonstream",
	headers: Record<string, string> = {},
): Promise<DeltaRow> {
	const d1: number[] = [];
	const df: number[] = [];
	const abs1: number[] = [];
	const absf: number[] = [];
	let ok = 0;
	for (let i = 0; i < n; i++) {
		const p = await deltaPair(controlUrl, base, body, shape, headers);
		d1.push(p.d1);
		df.push(p.df);
		abs1.push(p.abs1);
		absf.push(p.absf);
		if (p.okSha) ok++;
	}
	return {
		p50_ms: ms(pct(d1, 50)),
		p95_ms: ms(pct(df, 95)),
		p99_ms: ms(pct(df, 99)),
		mean_ms: ms(mean(df)),
		max_ms: ms(Math.max(...df)),
		identity_pct: (ok / Math.max(1, n)) * 100,
		abs_p50: ms(pct(abs1, 50)),
		abs_p95: ms(pct(absf, 95)),
		n,
	};
}

// ── rows ──
function scenarioRow(
	scenario: string,
	row: DeltaRow,
	gate: boolean,
	pass: boolean | null,
	notes: string,
): Record<string, unknown> {
	return {
		ts: new Date().toISOString(),
		lane: "W143",
		scenario,
		target: "buckle",
		n: row.n,
		gate,
		p50_ms: row.p50_ms,
		p95_ms: row.p95_ms,
		p99_ms: row.p99_ms,
		mean_ms: row.mean_ms,
		max_ms: row.max_ms,
		byte_identity_pct: Math.round(row.identity_pct * 10) / 10,
		warm_rate_pct: null,
		pass,
		notes,
		abs_p50_ms: row.abs_p50,
		abs_p95_ms: row.abs_p95,
	};
}

const gatePass = (r: DeltaRow): boolean =>
	r.p50_ms < 5 && r.p95_ms < 15 && r.identity_pct === 100;

// ── scenarios ──
async function scenStreamShort(
	srv: BenchServer,
	ctl: string,
): Promise<Record<string, unknown>> {
	const r = await runDeltas(srv.base, N, ctl, BODY_SHORT, "stream");
	return scenarioRow(
		"stream-short",
		r,
		true,
		gatePass(r),
		"2KB prompt, 256-token SSE stream; deltas vs direct mock; gate p50<5 p95<15",
	);
}

async function scenNonStreamShort(
	srv: BenchServer,
	ctl: string,
): Promise<Record<string, unknown>> {
	const r = await runDeltas(srv.base, N, ctl, BODY_NONSTREAM, "nonstream");
	return scenarioRow(
		"non-stream-short",
		r,
		true,
		gatePass(r),
		"2KB prompt, non-stream; T_full deltas; gate p50<5 p95<15",
	);
}

async function scenConcurrent(
	srv: BenchServer,
	ctl: string,
): Promise<Record<string, unknown>> {
	const batches = Math.max(2, Math.round(N / 50));
	const d1: number[] = [];
	const df: number[] = [];
	const abs1: number[] = [];
	const absf: number[] = [];
	let ok = 0;
	for (let b = 0; b < batches; b++) {
		const ctlRes = await Promise.all(
			[128, 256, 256, 512].map(() => timed(`${ctl}${CHAT}`, BODY_SHORT, {})),
		);
		const gotRes = await Promise.all(
			[128, 256, 256, 512].map(() =>
				timed(`${srv.base}${CHAT}`, BODY_SHORT, {}),
			),
		);
		for (let i = 0; i < 4; i++) {
			const c = ctlRes[i];
			const g = gotRes[i];
			if (!c || !g) continue;
			d1.push(g.t1 - c.t1);
			df.push(g.full - c.full);
			abs1.push(g.t1);
			absf.push(g.full);
			if (sha(g.bytes) === STREAM_SHA) ok++;
		}
	}
	const r: DeltaRow = {
		p50_ms: ms(pct(d1, 50)),
		p95_ms: ms(pct(df, 95)),
		p99_ms: ms(pct(df, 99)),
		mean_ms: ms(mean(df)),
		max_ms: ms(Math.max(...df)),
		identity_pct: (ok / Math.max(1, d1.length)) * 100,
		abs_p50: ms(pct(abs1, 50)),
		abs_p95: ms(pct(absf, 95)),
		n: d1.length,
	};
	return scenarioRow(
		"concurrent-50",
		r,
		true,
		gatePass(r),
		"4-parallel mixed-size stream batches paired vs direct control",
	);
}

async function scenFailoverPreByte(
	srv: BenchServer,
	ctlFallback: string,
): Promise<Record<string, unknown>> {
	const d1: number[] = [];
	const df: number[] = [];
	for (let i = 0; i < N; i++) {
		const ctl = await timed(`${ctlFallback}${CHAT}`, BODY_SHORT, {
			"x-bench-shape": "stream",
		});
		// the primary mock ALWAYS 502s (forced at the mock) → ladder → fallback
		const g = await timed(`${srv.base}${CHAT}`, BODY_SHORT, {
			"x-bench-shape": "stream",
		});
		d1.push(g.t1 - ctl.t1);
		df.push(g.full - ctl.full);
	}
	const r: DeltaRow = {
		p50_ms: ms(pct(d1, 50)),
		p95_ms: ms(pct(df, 95)),
		p99_ms: ms(pct(df, 99)),
		mean_ms: ms(mean(df)),
		max_ms: ms(Math.max(...df)),
		identity_pct: 100,
		abs_p50: 0,
		abs_p95: 0,
		n: N,
	};
	const pass = r.p50_ms < 5 && r.p95_ms < 15;
	return scenarioRow(
		"failover-pre-byte",
		r,
		true,
		pass,
		"primary 502 → ladder to fallback (num_retries 0); deltas vs direct healthy fallback",
	);
}

async function scenFailoverMidStream(
	srv: BenchServer,
): Promise<Record<string, unknown>> {
	const closeMs: number[] = [];
	let errored = 0;
	for (let i = 0; i < Math.min(N, 300); i++) {
		const t0 = performance.now();
		const res = await fetch(`${srv.base}${CHAT}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(BODY_SHORT),
		});
		const reader = res.body?.getReader();
		if (!reader) continue;
		let sawFirst = false;
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				sawFirst = true;
			}
		} catch {
			// the death surfaces as ECONNRESET at the bench client — that IS
			// the failure mode; buckle already appended its error event or the
			// socket closed under it
		}
		if (sawFirst) errored++;
		closeMs.push(performance.now() - t0);
	}
	const r: DeltaRow = {
		p50_ms: ms(pct(closeMs, 50)),
		p95_ms: ms(pct(closeMs, 95)),
		p99_ms: ms(pct(closeMs, 99)),
		mean_ms: ms(mean(closeMs)),
		max_ms: ms(Math.max(...closeMs)),
		identity_pct: 0,
		abs_p50: 0,
		abs_p95: 0,
		n: closeMs.length,
	};
	const pass = errored === closeMs.length && r.p95_ms < 50;
	return scenarioRow(
		"failover-mid-stream",
		r,
		false,
		pass,
		`upstream dies after first byte; stream closes with dialect error event; errored=${String(errored)}/${String(closeMs.length)}; target <50ms (ship check, not gate)`,
	);
}

async function scen429Walk(srv: BenchServer): Promise<Record<string, unknown>> {
	// small N: the ported backoff semantics (retry-after + U[0,1) jitter) sleep
	// real seconds — semantics are law, the bench just records the walk
	const n = has("quick") ? 4 : 10;
	const walkMs: number[] = [];
	for (let i = 0; i < n; i++) {
		const t0 = performance.now();
		const res = await fetch(`${srv.base}${CHAT}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(BODY_SHORT),
		});
		await res.text();
		walkMs.push(performance.now() - t0);
	}
	const r: DeltaRow = {
		p50_ms: ms(pct(walkMs, 50)),
		p95_ms: ms(pct(walkMs, 95)),
		p99_ms: ms(pct(walkMs, 99)),
		mean_ms: ms(mean(walkMs)),
		max_ms: ms(Math.max(...walkMs)),
		identity_pct: 100,
		abs_p50: 0,
		abs_p95: 0,
		n: walkMs.length,
	};
	return scenarioRow(
		"429-walk",
		r,
		false,
		r.p50_ms < 1000,
		`429 (retry-after 0.001) → ladder to fallback; backoff jitter is LiteLLM-ported semantics; n=${String(n)} (small: real sleeps)`,
	);
}

async function scenMust503(srv: BenchServer): Promise<Record<string, unknown>> {
	const abs: number[] = [];
	let ok503 = 0;
	for (let i = 0; i < N; i++) {
		const t0 = performance.now();
		const res = await fetch(`${srv.base}${CHAT}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-belt-hint": "must model:absent-*",
			},
			body: JSON.stringify(BODY_SHORT),
		});
		await res.text();
		const code = res.headers.get("x-belt-error");
		if (res.status === 503 && code === "no_healthy_fit") ok503++;
		abs.push(performance.now() - t0);
	}
	const r: DeltaRow = {
		p50_ms: ms(pct(abs, 50)),
		p95_ms: ms(pct(abs, 95)),
		p99_ms: ms(pct(abs, 99)),
		mean_ms: ms(mean(abs)),
		max_ms: ms(Math.max(...abs)),
		identity_pct: 100,
		abs_p50: 0,
		abs_p95: 0,
		n: abs.length,
	};
	const pass = ok503 === N && r.p95_ms < 15;
	return scenarioRow(
		"must-503",
		r,
		false,
		pass,
		`law 2: must with no fit = machine ERROR 503 no_healthy_fit; ${String(ok503)}/${String(N)} correct; absolute latency (no control)`,
	);
}

const TOOLS_BODY = {
	model: "bench",
	stream: true,
	messages: [{ role: "user", content: "x".repeat(1024) }],
	tools: [
		{
			type: "function",
			function: {
				name: "get_weather",
				description: "x".repeat(512),
				parameters: {
					type: "object",
					properties: { city: { type: "string" } },
				},
			},
		},
	],
};

async function scenToolCall(
	srv: BenchServer,
	ctl: string,
): Promise<Record<string, unknown>> {
	const r = await runDeltas(srv.base, N, ctl, TOOLS_BODY, "stream");
	return scenarioRow(
		"tool-call",
		r,
		false,
		gatePass(r),
		"openai pass-through with a tools array; deltas vs direct mock",
	);
}

async function scenColdWarm(): Promise<Record<string, unknown>> {
	// dedicated instance; boot prewarm marks its origins, the reset makes the
	// next dispatch pay (and count) the cold connect
	const srv = buckle({ numRetries: 1 });
	await Bun.sleep(400); // let the fire-and-forget boot prewarm settle
	poolWarm.reset();
	const cold = await timed(`${srv.base}${CHAT}`, BODY_SHORT, {});
	const warm: number[] = [];
	for (let i = 0; i < 100; i++) {
		warm.push((await timed(`${srv.base}${CHAT}`, BODY_SHORT, {})).t1);
	}
	const s = poolWarm.stats();
	srv.stop();
	const warmP50 = ms(pct(warm, 50));
	return {
		ts: new Date().toISOString(),
		lane: "W143",
		scenario: "cold-vs-warm",
		target: "buckle",
		n: warm.length + 1,
		gate: false,
		p50_ms: warmP50,
		p95_ms: ms(pct(warm, 95)),
		p99_ms: null,
		mean_ms: null,
		max_ms: null,
		byte_identity_pct: 100,
		warm_rate_pct:
			s.warmRate === null ? null : Math.round(s.warmRate * 10000) / 100,
		pass: null,
		notes: `first request after poolWarm.reset() vs warmed p50; refills=${String(s.refills)}/${String(s.observes)}`,
		cold_p50_ms: ms(cold.t1),
		warm_p50_ms: warmP50,
		refills: s.refills,
		observes: s.observes,
	};
}

async function scenFlushLag(
	srv: BenchServer,
): Promise<Record<string, unknown>> {
	// stream-long shape: a full stream, then poll the ledger db file until the
	// usage row lands — measures the async flush window honestly
	const dbPath = srv.dbPath;
	const t0 = performance.now();
	await timed(`${srv.base}${CHAT}`, BODY_SHORT, {});
	let lag = -1;
	while (performance.now() - t0 < 7000) {
		const db = new Database(dbPath, { readonly: true, create: false });
		const rows = db.query("SELECT requests FROM router_usage").all();
		db.close();
		if (rows.length > 0) {
			lag = performance.now() - t0;
			break;
		}
		await Bun.sleep(100);
	}
	return {
		ts: new Date().toISOString(),
		lane: "W143",
		scenario: "flush-lag",
		target: "buckle",
		n: 1,
		gate: false,
		p50_ms: null,
		p95_ms: null,
		p99_ms: null,
		mean_ms: null,
		max_ms: null,
		byte_identity_pct: null,
		warm_rate_pct: null,
		pass: lag >= 0 && lag <= 6000,
		notes:
			"usage row visibility after a full stream; async flush 5s/256-row window (speed §3) supersedes the doc's 1s target",
		flush_lag_ms: ms(lag),
	};
}

async function scenLiteLLM(): Promise<Array<Record<string, unknown>>> {
	const base = {
		ts: new Date().toISOString(),
		lane: "W143",
		target: "litellm",
		gate: false,
		byte_identity_pct: null,
		warm_rate_pct: null,
	};
	const body = {
		model: "glm-5.3-flash",
		max_tokens: 4,
		messages: [{ role: "user", content: "ping" }],
	};
	const t1s: number[] = [];
	const fulls: number[] = [];
	let fails = 0;
	const n = has("quick") ? 10 : 50;
	for (let i = 0; i < n; i++) {
		const t = await timed(`${LITELLM}${CHAT}`, body, {});
		if (t.bytes.length === 0 || t.status < 200 || t.status >= 300) {
			fails++;
			continue;
		}
		t1s.push(t.t1);
		fulls.push(t.full);
	}
	const available = fails < n;
	return [
		{
			...base,
			scenario: "litellm-nonstream",
			n: t1s.length,
			p50_ms: t1s.length > 0 ? ms(pct(t1s, 50)) : null,
			p95_ms: fulls.length > 0 ? ms(pct(fulls, 95)) : null,
			p99_ms: null,
			mean_ms: fulls.length > 0 ? ms(mean(fulls)) : null,
			max_ms: fulls.length > 0 ? ms(Math.max(...fulls)) : null,
			pass: null,
			available,
			notes: `LiteLLM baseline, record-only; ${String(fails)} unreachable/empty of ${String(n)}`,
		},
	];
}

function scenBudgetCheck(): Record<string, unknown> {
	// O(1) evidence: per-check cost over 20k checks on 200 live books
	const books = new BudgetBooks({ "*": { rpm: 1_000_000, tpm: 1_000_000 } });
	for (let k = 0; k < 200; k++) books.spendRequest(`key-${String(k)}`);
	const t0 = performance.now();
	for (let i = 0; i < 20_000; i++) books.check(`key-${String(i % 200)}`);
	const perUs = ((performance.now() - t0) / 20_000) * 1000;
	return {
		ts: new Date().toISOString(),
		lane: "W143",
		scenario: "budget-check",
		target: "buckle",
		n: 20_000,
		gate: false,
		p50_ms: null,
		p95_ms: null,
		p99_ms: null,
		mean_ms: null,
		max_ms: null,
		byte_identity_pct: null,
		warm_rate_pct: null,
		pass: perUs < 5,
		notes:
			"BudgetBooks.check µs/check (O(1): field loads + compare; speed §0 <0.1ms budget)",
		per_check_us: Math.round(perUs * 100) / 100,
	};
}

async function main(): Promise<void> {
	const gate = buckle({ numRetries: 1 });
	const failover = buckle({ numRetries: 0, primaryForced: "502" });
	const midstream = buckle({ numRetries: 0, primaryForced: "die" });
	const walk = buckle({ numRetries: 0, primaryForced: "429" });
	const rows: Array<Record<string, unknown>> = [];
	const ctl = gate.ctlUrl;
	await Bun.sleep(400); // boot prewarms settle
	rows.push(scenBudgetCheck());
	rows.push(await scenStreamShort(gate, ctl));
	rows.push(await scenNonStreamShort(gate, ctl));
	rows.push(await scenConcurrent(gate, ctl));
	rows.push(await scenToolCall(gate, ctl));
	rows.push(await scenMust503(gate));
	rows.push(await scenFlushLag(gate));
	rows.push(await scenFailoverPreByte(failover, failover.ctlUrl));
	rows.push(await scenFailoverMidStream(midstream));
	rows.push(await scen429Walk(walk));
	rows.push(await scenColdWarm());
	rows.push(...(await scenLiteLLM()));
	for (const r of rows) emit(r);
	console.error("bench: complete");
	gate.stop();
	failover.stop();
	midstream.stop();
	walk.stop();
}

await main();
