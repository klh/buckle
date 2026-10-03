// src/repo-policy.ts — W7 repo-policy gate engine: hub-connected sessions
// run policy CHECKS on the repo in view, keyed by repo-class. Every policy
// is a DATA row {id, repoClass, detect, check, missingQuestion, policySource}
// in repo-policy.yaml (same resolution chain as routing-policy.yaml —
// operators edit the YAML, never code; rows are additive without code
// changes). Silent when satisfied: an applied row whose checks all pass
// contributes no prose; a found gap contributes exactly one actionable
// missing-question to the owner. IKEA-internal policy text never commits —
// rows point at LOCAL-ONLY coord facts (finding.ikea-*) via
// policySource: "fact:<name>", resolved only on the local owner-report
// path (bin/repo-policy.ts --resolve-facts), never on the wire, never fed
// to a model.
import { YAML } from "bun";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";

/** The committed default rows (repo root, beside routing-policy.yaml). */
export const REPO_POLICY_DEFAULT = new URL(
	"../repo-policy.yaml",
	import.meta.url,
).pathname;

/** Bounded reads (streams law): grep/grepAny read at most the first MiB of
 *  a file — a pattern living past that is a row-design bug. */
export const MAX_POLICY_FILE_BYTES = 1024 * 1024;

export interface RepoPolicyRow {
	/** Stable row id — a metering label: never renamed, only added to. */
	id: string;
	/** The repo class the row speaks for ("api", "any", …) — reporting label. */
	repoClass: string;
	/** When the row applies: ALL must hold. Absent = applies to every repo. */
	detect?: Condition[];
	/** The policy: ALL must hold; the first failure = one gap. */
	check: Condition[];
	/** The single actionable question the owner gets when a gap is found. */
	missingQuestion: string;
	/** "commit" — this committed default; or a LOCAL-ONLY coord-fact pointer
	 *  (fact:finding.ikea-<topic>) whose text never enters the repo. */
	policySource: string;
}

/** The declarative condition grammar (v1) — everything a row can express
 *  without code: bounded file/grep evidence plus a live http probe. */
export type Condition =
	| { exists: string }
	| { existsAny: string[] }
	| { grep: string; pattern: string; flags?: string }
	| { grepAny: string[]; pattern: string; flags?: string }
	| { httpGet: string; expect?: number; timeoutS?: number };

/** A gap = the row's one actionable missing-question plus its source. */
export interface RepoPolicyGap {
	id: string;
	repoClass: string;
	missingQuestion: string;
	policySource: string;
}

export interface RepoPolicySkip {
	id: string;
	repoClass: string;
	reason: string;
}

export interface RepoPolicyReport {
	repo: string;
	sid: string | null;
	/** Rows whose detect matched (checked or skipped). */
	applied: number;
	/** Ids whose checks all held — silent on the wire beyond the count. */
	satisfied: string[];
	gaps: RepoPolicyGap[];
	skips: RepoPolicySkip[];
}

export interface RunOpts {
	rows: RepoPolicyRow[];
	/** Caller-supplied base for httpGet checks (the session's deployment);
	 *  absent → httpGet conditions skip honestly (never a false gap). */
	baseUrl?: string | null;
	fetch?: typeof fetch;
	maxFileBytes?: number;
}

/** One condition: holds, fails (a gap), or cannot run (an honest skip). */
export type Verdict = { ok: true } | { ok: false; skipReason?: string };

/** Row paths resolve under the repo root; absolute row paths are taken
 *  as-is (operator-authored YAML is trusted; repo_root comes from callers). */
function under(root: string, p: string): string {
	return isAbsolute(p) ? p : join(root, p);
}

/** Bounded read: up to cap bytes of a regular file, else null. */
function readCapped(path: string, cap: number): string | null {
	try {
		const st = statSync(path);
		if (!st.isFile()) return null;
		const bytes = readFileSync(path);
		const buf = bytes.length > cap ? bytes.subarray(0, cap) : bytes;
		return buf.toString("utf8");
	} catch {
		return null;
	}
}

function compile(cond: Condition): RegExp {
	const flags = "flags" in cond && cond.flags ? cond.flags : "";
	return new RegExp(cond.pattern, flags);
}

function evalCondition(
	cond: Condition,
	opts: RunOpts & { root: string },
): Verdict | Promise<Verdict> {
	const cap = opts.maxFileBytes ?? MAX_POLICY_FILE_BYTES;
	if ("exists" in cond)
		return { ok: existsSync(under(opts.root, cond.exists)) };
	if ("existsAny" in cond)
		return { ok: cond.existsAny.some((p) => existsSync(under(opts.root, p))) };
	if ("grep" in cond) {
		const text = readCapped(under(opts.root, cond.grep), cap);
		if (text === null)
			return { ok: false, skipReason: `unreadable: ${cond.grep}` };
		return { ok: compile(cond).test(text) };
	}
	if ("grepAny" in cond) {
		for (const p of cond.grepAny) {
			const text = readCapped(under(opts.root, p), cap);
			if (text !== null && compile(cond).test(text)) return { ok: true };
		}
		return { ok: false };
	}
	if ("httpGet" in cond) return evalHttpGet(cond, opts);
	return { ok: false, skipReason: "unknown condition" };
}

/** Live probe (httpGet): needs a caller-supplied base. Unreachable/absent
 *  base = honest skip — a service that is down is not a policy violation. */
function evalHttpGet(
	cond: Extract<Condition, { httpGet: string }>,
	opts: RunOpts & { root: string },
): Promise<Verdict> {
	if (!opts.baseUrl)
		return Promise.resolve({ ok: false, skipReason: "no base_url" });
	const url = `${opts.baseUrl.replace(/\/+$/, "")}${cond.httpGet}`;
	const timeoutMs = (cond.timeoutS ?? 2) * 1000;
	return (opts.fetch ?? fetch)(url, {
		method: "GET",
		signal: AbortSignal.timeout(timeoutMs),
	})
		.then((res): Verdict => {
			const expectN = "expect" in cond ? cond.expect : undefined;
			const pass =
				expectN !== undefined ? res.status === expectN : res.status < 500;
			return pass ? { ok: true } : { ok: false };
		})
		.catch(
			(err: unknown): Verdict => ({
				ok: false,
				skipReason: `probe failed: ${err instanceof Error ? err.message : String(err)}`,
			}),
		);
}

/** ALL conditions hold? (detect semantics; an empty list always holds.) */
async function evalAll(
	conds: Condition[],
	ctx: RunOpts & { root: string },
): Promise<boolean> {
	for (const cond of conds) {
		const v = await evalCondition(cond, ctx);
		if (!v.ok) return false;
	}
	return true;
}

type RowOutcome =
	| { outcome: "satisfied" }
	| { outcome: "gap" }
	| { outcome: "skip"; reason: string };

/** First failing/skipping check decides the row; ALL held → satisfied. */
async function firstVerdict(
	conds: Condition[],
	ctx: RunOpts & { root: string },
): Promise<RowOutcome> {
	for (const cond of conds) {
		const v = await evalCondition(cond, ctx);
		if (v.ok) continue;
		return v.skipReason !== undefined
			? { outcome: "skip", reason: v.skipReason }
			: { outcome: "gap" };
	}
	return { outcome: "satisfied" };
}

/** Run every row against the repo in view. Rows run in declaration order:
 *  detect failing = row inert (silent); first failing check = one gap
 *  carrying the row's missingQuestion; unrunnable check = honest skip. */
export async function runRepoPolicies(
	repo: string,
	opts: RunOpts & { sid?: string | null },
): Promise<RepoPolicyReport> {
	const ctx: RunOpts & { root: string } = { ...opts, root: repo };
	const satisfied: string[] = [];
	const gaps: RepoPolicyGap[] = [];
	const skips: RepoPolicySkip[] = [];
	let applied = 0;
	for (const row of opts.rows) {
		if (!(await evalAll(row.detect ?? [], ctx))) continue;
		applied += 1;
		const v = await firstVerdict(row.check, ctx);
		if (v.outcome === "satisfied") satisfied.push(row.id);
		else if (v.outcome === "gap") {
			gaps.push({
				id: row.id,
				repoClass: row.repoClass,
				missingQuestion: row.missingQuestion,
				policySource: row.policySource,
			});
		} else {
			skips.push({ id: row.id, repoClass: row.repoClass, reason: v.reason });
		}
	}
	return { repo, sid: opts.sid ?? null, applied, satisfied, gaps, skips };
}

/** Row validation: a malformed row throws NAMING the row — operators edit
 *  the YAML, and silent inertness is the one forbidden posture (never
 *  silent). Only scalar presence is checked here; condition shape errors
 *  surface at eval time as honest skips. */
function validateRow(raw: unknown, i: number): RepoPolicyRow {
	const r = (raw ?? {}) as Partial<RepoPolicyRow>;
	const label =
		typeof r.id === "string" && r.id.length > 0 ? r.id : `row[${i}]`;
	const need = (v: unknown, what: string): string => {
		if (typeof v !== "string" || v.length === 0)
			throw new Error(`repo-policy ${label}: missing ${what}`);
		return v;
	};
	const id = need(r.id, "id");
	const missingQuestion = need(r.missingQuestion, "missingQuestion");
	const policySource = need(r.policySource, "policySource");
	const check = Array.isArray(r.check) ? (r.check as Condition[]) : [];
	if (check.length === 0)
		throw new Error(`repo-policy ${label}: check must be a non-empty list`);
	return {
		id,
		repoClass:
			typeof r.repoClass === "string" && r.repoClass.length > 0
				? r.repoClass
				: "any",
		detect: Array.isArray(r.detect) ? (r.detect as Condition[]) : undefined,
		check,
		missingQuestion,
		policySource,
	};
}

/** Rows resolve like the gateway policy: explicit path → BUCKLE_REPO_POLICY
 *  → the runtime copy in the local-llm dir → the committed default. A repo
 *  with no rows anywhere is a valid inert posture, not an error. */
export function loadRepoPolicies(explicitPath?: string): {
	rows: RepoPolicyRow[];
	source: string;
} {
	const candidates = [
		explicitPath,
		process.env.BUCKLE_REPO_POLICY,
		`${process.env.HOME ?? ""}/.claude/local-llm/repo-policy.yaml`,
		REPO_POLICY_DEFAULT,
	].filter((p): p is string => typeof p === "string" && p.length > 0);
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		const doc = YAML.parse(readFileSync(p, "utf8")) as {
			rows?: unknown;
		} | null;
		const rawRows = Array.isArray(doc?.rows) ? doc.rows : [];
		return { rows: rawRows.map(validateRow), source: p };
	}
	return { rows: [], source: "none" };
}

/** fact:<name> expansion — LOCAL OWNER-REPORT PATH ONLY. The coord CLI is
 *  spawned with argument arrays (never a shell string); the resolved text
 *  must never reach an LLM context (IKEA law), so nothing on the wire path
 *  calls this. */
const FACT_MAX_BYTES = 8 * 1024;

async function runCoordFact(
	argv: string[],
): Promise<{ code: number; text: string }> {
	const proc = Bun.spawn(argv, {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const text = await new Response(proc.stdout).text();
	// capped after read — coord facts are small; the cap bounds the report,
	// not the pipe (the source is this machine's own control plane).
	const capped =
		text.length > FACT_MAX_BYTES ? text.slice(0, FACT_MAX_BYTES) : text;
	return { code: await proc.exited, text: capped };
}

/** Expand a policySource: "commit" → itself; "fact:<name>" → the coord
 *  fact's text (capped), or an honest failure suffix. */
export async function resolvePolicySource(
	src: string,
	run: (
		argv: string[],
	) => Promise<{ code: number; text: string }> = runCoordFact,
): Promise<string> {
	if (!src.startsWith("fact:")) return src;
	const out = await run(["coord", "fact", "get", src.slice("fact:".length)]);
	if (out.code !== 0) return `${src} (coord fact get exit ${out.code})`;
	return out.text.trim() || `${src} (empty fact)`;
}
