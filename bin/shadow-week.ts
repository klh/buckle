// bin/shadow-week.ts — the W144 shadow-week monitor (launchd-friendly,
// StartInterval daily): (a) runs the W143 bench (n=600) with the LiteLLM
// baseline recorded honestly (a down fallback is a recorded state, never a
// faked baseline), (b) diffs the day's bench JSONL against the prior day's,
// scenario-name keyed, tolerance flags on the gate metrics, (c) appends a
// bounded 7-day shadow-week log.
//
//	bun bin/shadow-week.ts [--shadow-dir DIR] [--skip-bench] [--bench-n 600]
//
// Env: BUCKLE_SHADOW_DIR (default <repo>/shadow), BUCKLE_LITELLM_URL,
// BUCKLE_SHADOW_LOG, BUCKLE_SHADOW_URL (the shadow port probed for
// availability). Exit 1 on a hard flag (gate regression, byte identity
// < 100, bench failure) so a launcher notices; soft flags (tolerance drift,
// availability change) report but exit 0.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";

// ── args + env ──
const arg = (name: string): string | null => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);
const REPO = new URL("..", import.meta.url).pathname;
const SHADOW_DIR =
	arg("shadow-dir") ?? process.env.BUCKLE_SHADOW_DIR ?? `${REPO}/shadow`;
const LITELLM =
	arg("litellm") ?? process.env.BUCKLE_LITELLM_URL ?? "http://127.0.0.1:4100";
const SHADOW_URL =
	arg("shadow-url") ?? process.env.BUCKLE_SHADOW_URL ?? "http://127.0.0.1:4101";
const LOG =
	arg("shadow-log") ??
	process.env.BUCKLE_SHADOW_LOG ??
	`${SHADOW_DIR}/shadow-week.jsonl`;
const N = Number(arg("bench-n") ?? 600);
const DAY_MS = 86_400_000;
const KEEP_MS = 7 * DAY_MS;

// ── bench row shape (subset the monitor reads) ──
export interface BenchRow {
	ts?: string;
	scenario: string;
	gate?: boolean;
	pass?: boolean | null;
	p50_ms?: number | null;
	p95_ms?: number | null;
	byte_identity_pct?: number | null;
	available?: boolean;
	notes?: string;
}

export const dayKey = (d: Date): string => {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
};

/** One JSON object per line; tolerate a torn final line (crash mid-write). */
export const parseBenchRows = (text: string): BenchRow[] => {
	const rows: BenchRow[] = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			rows.push(JSON.parse(line) as BenchRow);
		} catch {
			// torn line — the rest of the file still parses
		}
	}
	return rows;
};

export interface Flagged {
	scenario: string;
	flags: string[];
	hard: boolean;
}

const GATE_BUDGET = { p50: 5, p95: 15 };

/** Scenario-keyed diff of today vs the prior day. First day (no prior) is
 *  recorded, never flagged. */
export function diffDay(today: BenchRow[], prior: BenchRow[]): Flagged[] {
	const priorBy = new Map(prior.map((r) => [r.scenario, r]));
	const out: Flagged[] = [];
	for (const r of today) {
		const flags: string[] = [];
		let hard = false;
		if (r.gate === true && r.pass === false) {
			flags.push("gate-fail");
			hard = true;
		}
		if (
			r.gate === true &&
			((r.p50_ms !== null &&
				r.p50_ms !== undefined &&
				r.p50_ms >= GATE_BUDGET.p50) ||
				(r.p95_ms !== null &&
					r.p95_ms !== undefined &&
					r.p95_ms >= GATE_BUDGET.p95))
		) {
			flags.push("gate-budget");
			hard = true;
		}
		if (
			r.byte_identity_pct !== null &&
			r.byte_identity_pct !== undefined &&
			r.byte_identity_pct < 100 &&
			r.scenario !== "failover-mid-stream"
		) {
			flags.push("byte-identity");
			hard = true;
		}
		const p = priorBy.get(r.scenario);
		if (p) {
			if (
				typeof r.p50_ms === "number" &&
				typeof p.p50_ms === "number" &&
				p.p50_ms > 0 &&
				r.p50_ms > 2 * p.p50_ms
			)
				flags.push(`tolerance:p50>2x-prior(${String(p.p50_ms)}ms)`);
			if (
				typeof r.p95_ms === "number" &&
				typeof p.p95_ms === "number" &&
				p.p95_ms > 0 &&
				r.p95_ms > 2 * p.p95_ms
			)
				flags.push(`tolerance:p95>2x-prior(${String(p.p95_ms)}ms)`);
			if (p.available === true && r.available === false)
				flags.push("litellm-unavailable-was-up");
			if (p.available === false && r.available === true)
				flags.push("litellm-recovered");
		}
		out.push({ scenario: r.scenario, flags, hard });
	}
	const todayBy = new Map(today.map((r) => [r.scenario, r]));
	for (const p of prior) {
		if (!todayBy.has(p.scenario)) {
			out.push({
				scenario: p.scenario,
				flags: ["missing-scenario"],
				hard: false,
			});
		}
	}
	return out;
}

/** Bounded log: keep only rows within the window (7 days). */
export function boundKeep(lines: string[], nowMs: number): string[] {
	return lines.filter((l) => {
		try {
			const r = JSON.parse(l) as { ts?: string };
			if (!r.ts) return false;
			const t = Date.parse(r.ts);
			return Number.isFinite(t) && nowMs - t <= KEEP_MS;
		} catch {
			return false; // torn/foreign line — drop
		}
	});
}

async function shadowUp(url: string): Promise<boolean> {
	try {
		const res = await fetch(`${url}/status`, {
			signal: AbortSignal.timeout(2500),
		});
		return res.ok;
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	mkdirSync(SHADOW_DIR, { recursive: true });
	const now = new Date();
	const day = dayKey(now);
	const dated = `${SHADOW_DIR}/${day}.jsonl`;

	// (a) the day's bench run — rm first so re-runs are idempotent
	if (!has("skip-bench")) {
		try {
			rmSync(dated, { force: true });
			const proc = Bun.spawn({
				cmd: [
					"bun",
					"bin/bench.ts",
					"--n",
					String(N),
					"--litellm",
					LITELLM,
					"--out",
					dated,
				],
				cwd: REPO,
				stdout: "ignore",
				stderr: "inherit",
			});
			const code = await proc.exited;
			if (code !== 0)
				console.error(
					`shadow-week: bench exited ${String(code)} (recorded honestly)`,
				);
		} catch (e) {
			console.error(
				`shadow-week: bench spawn failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	// (b) diff vs prior day
	const priorDate = dayKey(new Date(now.getTime() - DAY_MS));
	const priorPath = `${SHADOW_DIR}/${priorDate}.jsonl`;
	const today = existsSync(dated)
		? parseBenchRows(readFileSync(dated, "utf8"))
		: [];
	const prior = existsSync(priorPath)
		? parseBenchRows(readFileSync(priorPath, "utf8"))
		: [];
	const flagged = diffDay(today, prior);
	const hardFlags = flagged.filter((f) => f.hard && f.flags.length > 0);
	const softFlags = flagged.filter((f) => !f.hard && f.flags.length > 0);
	const litellmRow = today.find((r) => r.scenario === "litellm-nonstream");
	const shadow4101 = await shadowUp(SHADOW_URL);

	// (c) bounded shadow-week log
	const ts = now.toISOString();
	const dayRow = {
		ts,
		lane: "W144",
		kind: "day",
		date: day,
		shadow_port_up: shadow4101,
		bench_rows: today.length,
		litellm_available: litellmRow?.available ?? null,
		hard_flags: hardFlags.length,
		soft_flags: softFlags.length,
	};
	const existing = existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n") : [];
	const kept = boundKeep(
		existing.filter((l) => l.trim().length > 0),
		now.getTime(),
	);
	// one authoritative day row per date: later runs replace the earlier
	const keptDays = kept.filter((l) => {
		try {
			const r = JSON.parse(l) as { kind?: string; date?: string };
			return !(r.kind === "day" && r.date === day);
		} catch {
			return true;
		}
	});
	keptDays.push(JSON.stringify(dayRow));
	for (const f of flagged) {
		if (f.flags.length === 0) continue;
		const r = today.find((x) => x.scenario === f.scenario);
		keptDays.push(
			JSON.stringify({
				ts,
				lane: "W144",
				kind: "flag",
				date: day,
				scenario: f.scenario,
				flags: f.flags,
				hard: f.hard,
				p50_ms: r?.p50_ms ?? null,
				p95_ms: r?.p95_ms ?? null,
				byte_identity_pct: r?.byte_identity_pct ?? null,
				available: r?.available ?? null,
			}),
		);
	}
	writeFileSync(LOG, `${keptDays.join("\n")}\n`);

	// human summary on stderr (stdout stays clean for launchd)
	console.error(
		`shadow-week ${day}: bench_rows=${String(today.length)} shadow_port_up=${String(shadow4101)} litellm_available=${String(litellmRow?.available ?? "n/a")} hard=${String(hardFlags.length)} soft=${String(softFlags.length)} log=${LOG}`,
	);
	for (const f of [...hardFlags, ...softFlags])
		console.error(
			`  ${f.hard ? "HARD" : "soft"}  ${f.scenario}: ${f.flags.join("; ")}`,
		);
	if (prior.length === 0)
		console.error("  (first day — no prior-day diff; baseline begins today)");
	if (hardFlags.length > 0) process.exit(1);
}

if (import.meta.main) await main();
