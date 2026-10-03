// src/pipeline.ts — W5 prompt pipeline IN: inbound compression. Lane
// results/summaries shown to the owner get a condensed variant computed
// SIDE-BAND (the served bytes stay byte-identical — the wire contract is
// never mutated); the raw output stays one GET away by rid. The ruleset is
// the politeness-only family (finding.condense-token-bench): rule-based,
// deterministic, meaning-preserving — whole courtesy sentences drop,
// courtesy prefixes strip, whitespace collapses; meaning qualifiers ("but
// just for the 429 case", "only touch the users table") survive verbatim
// because rules never edit inside a sentence or inside code.
import { Database } from "bun:sqlite";

// ─── the ruleset ────────────────────────────────────────────────────────────

/** Whole-line courtesy sentences: zero payload, safe to drop entirely. */
const DROP_LINE: RegExp[] = [
	/^(i |we )?hope (this|that|it) helps\b.*$/i,
	/^let me know\b.*$/i,
	/^(feel free|don'?t hesitate) to\b.*$/i,
	/^(happy|glad) to (help|elaborate|clarify|explain|answer)\b.*$/i,
	/^(thanks|thank you|many thanks|cheers)[!.,\s]*$/i,
	/^(you'?re welcome|my pleasure|anytime)[!.,\s]*$/i,
];

/** Courtesy prefixes stripped at line start; the payload survives verbatim.
 *  Bullets ("- ", "* ", "1. ") are preserved through the strip. */
const PREFIX_STRIP: RegExp[] = [
	/^(?<bullet>[-*+] |\d+[.)] )?(please|kindly)\s+(note|be aware|keep in mind)( that)?\s*[:,]?\s*/i,
	/^(?<bullet>[-*+] |\d+[.)] )?(it'?s|it is) (worth|important) (noting|to note)( that)?[:,]?\s*/i,
	/^(?<bullet>[-*+] |\d+[.)] )?(just a )?(heads-?up|fyi)\s*[-—–:]?\s*/i,
	/^(?<bullet>[-*+] |\d+[.)] )?please\s+/i,
];

/** Whitespace collapse: ≥3 newlines → one blank line; no trailing spaces. */
function collapseWhitespace(text: string): string {
	return text
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\n+/, "")
		.replace(/\n+$/, "\n");
}

/** Inline-code hoist sentinel: `%%C<i>%%` — token-shaped so no legal prose
 *  or code span collides with it, and the restore regex stays lint-clean. */
const SENTINEL = (i: number): string => `%%C${i}%%`;
const SENTINEL_RE = /%%C(\d+)%%/g;

/** Hoist inline code spans out of the text (placeholder swap) so line rules
 *  never see their contents; restore after. */
function swapInlineCode(text: string): { text: string; saved: string[] } {
	const saved: string[] = [];
	const swapped = text.replace(/`[^`\n]+`/g, (m) => {
		saved.push(m);
		return SENTINEL(saved.length - 1);
	});
	return { text: swapped, saved };
}

function restoreInlineCode(text: string, saved: string[]): string {
	return text.replace(SENTINEL_RE, (_, i) => saved[Number(i)] ?? "");
}

export interface CondenseResult {
	/** The condensed text (=== input when no rule fired). */
	text: string;
	/** The rules that fired, in order. Empty = nothing changed. */
	rules: string[];
}

/** The politeness-only inbound pass. Fenced code blocks and inline code
 *  spans are never touched; meaning qualifiers inside sentences survive by
 *  construction (rules are line-anchored, never word-deletions). */
export function condenseText(raw: string): CondenseResult {
	const rules: string[] = [];
	const { text: hoisted, saved } = swapInlineCode(raw);
	const lines = hoisted.split("\n");
	const out: string[] = [];
	let fence = false;
	for (const line of lines) {
		if (/^\s*(```|~~~)/.test(line)) {
			fence = !fence;
			out.push(line);
			continue;
		}
		if (fence) {
			out.push(line);
			continue;
		}
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			out.push(line);
			continue;
		}
		let text = line;
		let dropped = false;
		for (const re of DROP_LINE) {
			if (re.test(trimmed)) {
				dropped = true;
				rules.push(`drop:${re.source.slice(1, 24)}`);
				break; // first match in declaration order wins
			}
		}
		if (dropped) continue;
		for (const re of PREFIX_STRIP) {
			const m = re.exec(text);
			if (m && m[0].length < text.trimStart().length) {
				text = (m.groups?.bullet ?? "") + text.slice(m[0].length);
				rules.push(`prefix:${re.source.slice(1, 24)}`);
				break;
			}
		}
		out.push(text);
	}
	let text = collapseWhitespace(out.join("\n"));
	text = restoreInlineCode(text, saved);
	if (rules.length === 0 && text === raw) return { text: raw, rules };
	return { text, rules };
}

// ─── the dialect text extractor ─────────────────────────────────────────────

/** Assistant text out of a non-streaming chat response (the inbound face).
 *  Anything this can't honestly extract → null (metered skip). */
export function extractText(
	dialect: "openai" | "anthropic",
	parsed: unknown,
): string | null {
	if (parsed === null || typeof parsed !== "object") return null;
	const p = parsed as Record<string, unknown>;
	if (dialect === "anthropic") {
		const content = p.content;
		if (!Array.isArray(content)) return null;
		const text = content
			.filter(
				(b): b is { type: "text"; text: string } =>
					typeof b === "object" &&
					b !== null &&
					(b as { type?: string }).type === "text" &&
					typeof (b as { text?: string }).text === "string",
			)
			.map((b) => b.text)
			.join("\n");
		return text.length > 0 ? text : null;
	}
	const choices = p.choices;
	if (!Array.isArray(choices) || choices.length === 0) return null;
	const msg = (choices[0] as { message?: { content?: unknown } }).message;
	const content = msg?.content;
	if (typeof content === "string" && content.length > 0) return content;
	return null;
}

// ─── the sidestore ──────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pipeline_in (
  rid TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  dialect TEXT NOT NULL,
  condensed TEXT NOT NULL,
  raw TEXT NOT NULL,
  rules TEXT NOT NULL DEFAULT '[]',
  raw_bytes INTEGER NOT NULL,
  condensed_bytes INTEGER NOT NULL
);
`;

const MAX_ROWS = 500;

/** The raw stays one GET away: rid-keyed rows in the shared buckle db (own
 *  WAL connection — the Ledger/AidsLedger precedent). Bounded at 500 rows
 *  (newest win); raw+condensed both live here, nothing is lost. */
export class CondenseStore {
	private readonly db: Database;

	constructor(
		path: string,
		private readonly now: () => Date = () => new Date(),
	) {
		this.db = new Database(path, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
	}

	put(input: {
		rid: string;
		dialect: string;
		condensed: string;
		raw: string;
		rules: string[];
	}): void {
		this.db
			.query(
				`INSERT INTO pipeline_in
         (rid, ts, dialect, condensed, raw, rules, raw_bytes, condensed_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(rid) DO UPDATE SET
         ts = excluded.ts, condensed = excluded.condensed, raw = excluded.raw,
         rules = excluded.rules, raw_bytes = excluded.raw_bytes,
         condensed_bytes = excluded.condensed_bytes`,
			)
			.run(
				input.rid,
				this.now().getTime(),
				input.dialect,
				input.condensed,
				input.raw,
				JSON.stringify(input.rules),
				Buffer.byteLength(input.raw),
				Buffer.byteLength(input.condensed),
			);
		// bounded: newest 500 rows win
		this.db
			.query(
				`DELETE FROM pipeline_in WHERE rid NOT IN (
           SELECT rid FROM pipeline_in ORDER BY ts DESC, rid DESC LIMIT ?
         )`,
			)
			.run(MAX_ROWS);
	}

	get(rid: string): {
		rid: string;
		ts: number;
		dialect: string;
		condensed: string;
		raw: string;
		rules: string[];
		raw_bytes: number;
		condensed_bytes: number;
	} | null {
		const row = this.db
			.query(
				"SELECT rid, ts, dialect, condensed, raw, rules, raw_bytes, condensed_bytes FROM pipeline_in WHERE rid = ?",
			)
			.get(rid) as {
			rid: string;
			ts: number;
			dialect: string;
			condensed: string;
			raw: string;
			rules: string;
			raw_bytes: number;
			condensed_bytes: number;
		} | null;
		if (!row) return null;
		return { ...row, rules: JSON.parse(row.rules) as string[] };
	}

	/** Newest rows first (the board's "recent" list). */
	list(limit = 25): Array<{
		rid: string;
		ts: number;
		dialect: string;
		raw_bytes: number;
		condensed_bytes: number;
	}> {
		return this.db
			.query(
				"SELECT rid, ts, dialect, raw_bytes, condensed_bytes FROM pipeline_in ORDER BY ts DESC, rid DESC LIMIT ?",
			)
			.all(Math.min(Math.max(1, limit), 100)) as Array<{
			rid: string;
			ts: number;
			dialect: string;
			raw_bytes: number;
			condensed_bytes: number;
		}>;
	}

	close(): void {
		this.db.close();
	}
}

// ─── the routes ─────────────────────────────────────────────────────────────

/** GET /pipeline/in/<rid> → {condensed, raw, …} (raw one click away).
 *  GET /pipeline/in?limit=N → newest summaries (the board's list face).
 *  Bare deps (no pipeline store) 404 honestly — the AppDeps contract. */
export async function pipelineRoutes(
	deps: {
		pipeline?: CondenseStore;
	},
	req: Request,
	path: string,
): Promise<Response | null> {
	if (!path.startsWith("/pipeline/in")) return null;
	if (!deps.pipeline) return problem404(`no route: ${req.method} ${path}`);
	if (path === "/pipeline/in" && req.method === "GET") {
		const limit = Number(new URL(req.url).searchParams.get("limit") ?? "25");
		return Response.json({ ok: true, rows: deps.pipeline.list(limit) });
	}
	const rid = path.slice("/pipeline/in/".length);
	if (rid.length > 0 && req.method === "GET") {
		const row = deps.pipeline.get(rid);
		if (!row) return problem404(`no condense row for rid ${rid}`);
		return Response.json({ ok: true, ...row });
	}
	return null;
}

function problem404(why: string): Response {
	return Response.json(
		{
			type: "/problems/not_found",
			title: "Not Found",
			status: 404,
			detail: why,
			code: "buckle.no_route",
		},
		{ status: 404, headers: { "content-type": "application/problem+json" } },
	);
}
