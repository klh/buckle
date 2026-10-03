// src/aids.ts — W142 knowledge-aids metering core. The W137 design's piece 1
// (built first so every later aid lands measured): one event per aid
// decision into a buckle-local WAL sqlite, govdb-shaped hourly rollup, and
// the stanza grammar that lane briefs declare ("aids: preseed=gaps
// cache-align"). Standing law: est_tok_saved stays NULL at event time —
// savings estimates are A/B facts applied at dashboard time, never
// fabricated per-request. An aid that cannot log does not fire.
import { Database } from "bun:sqlite";

/** The five declared keys; unknown keys are ignored (forward-compatible). */
export type AidKey =
	| "preseed"
	| "cache-align"
	| "compress"
	| "expand"
	| "condense-in"
	| "off";

export interface AidsStanza {
	preseed?: { domain: string; focus: string[] };
	"cache-align"?: boolean;
	compress?: boolean;
	expand?: boolean;
	/** W5 prompt pipeline IN: response-side condense (sideband, see
	 *  pipeline.ts). Declared per request; the served bytes never change. */
	"condense-in"?: boolean;
	off: boolean;
	unknown: string[];
}

/** Parse the aids stanza ("preseed=gaps:work-graph cache-align"). `off`
 *  wins over everything; a lone `preseed` without `=domain` is malformed
 *  and ignored (logged via unknown). */
export function parseAids(raw: string | null | undefined): AidsStanza {
	const out: AidsStanza = { off: false, unknown: [] };
	const parts = (raw ?? "")
		.split(/\s+/)
		.map((s) => s.trim())
		.filter(Boolean);
	for (const p of parts) {
		const [key, val] = p.split("=", 2);
		switch (key) {
			case "off":
				out.off = true;
				break;
			case "preseed": {
				const spec = (val ?? "").split(":");
				const domain = (spec[0] ?? "").trim();
				if (!domain) {
					out.unknown.push(p);
					break;
				}
				out.preseed = {
					domain,
					focus: spec
						.slice(1)
						.flatMap((f) => f.split(","))
						.map((f) => f.trim())
						.filter(Boolean),
				};
				break;
			}
			case "cache-align":
				out["cache-align"] = true;
				break;
			case "compress":
				out.compress = true;
				break;
			case "expand":
				out.expand = true;
				break;
			case "condense-in":
				out["condense-in"] = true;
				break;
				break;
			default:
				out.unknown.push(p);
		}
	}
	return out;
}

/** Per-decision event (W137 §3d shape + the local dedupe/breakdown extras
 *  govdb's table doesn't carry). */
export interface AidEventInput {
	ts: number;
	aid: string;
	decision: "injected" | "skipped" | "rebuilt";
	skip_reason?: string | null;
	domain?: string;
	repo_root?: string | null;
	sid?: string | null;
	work_item?: string | null;
	packet_id?: string | null;
	/** W4 expand: the REAL serving model (the deployment that produced the
	 *  digest), never the group alias. Absent for caller-served aids. */
	served_model?: string;
	tokens_injected?: number;
	est_tok_saved?: number | null;
	rows?: {
		total: number;
		verified: number;
		doc_covered: number;
		unverified: number;
	};
	basis?: string;
}

export interface AidEventRow extends AidEventInput {
	id: number;
	event_id: string;
	repo_fp: string;
}

/** sha256 of the repo root PATH — the path itself is never stored. */
export function repoFp(root: string): string {
	return new Bun.CryptoHasher("sha256").update(root).digest("hex").slice(0, 16);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS aid_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  aid TEXT NOT NULL,
  decision TEXT NOT NULL,
  skip_reason TEXT,
  domain TEXT NOT NULL DEFAULT '',
  repo_fp TEXT NOT NULL DEFAULT '',
  sid TEXT,
  work_item TEXT,
  packet_id TEXT,
  served_model TEXT,
  tokens_injected INTEGER NOT NULL DEFAULT 0,
  est_tok_saved INTEGER,
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_verified INTEGER NOT NULL DEFAULT 0,
  rows_doc_covered INTEGER NOT NULL DEFAULT 0,
  rows_unverified INTEGER NOT NULL DEFAULT 0,
  basis TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS aid_rollup (
  hour_bucket INTEGER NOT NULL,
  aid TEXT NOT NULL,
  domain TEXT NOT NULL,
  model_group TEXT NOT NULL,
  injected INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  tok_injected INTEGER NOT NULL DEFAULT 0,
  est_tok_saved INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour_bucket, aid, domain, model_group)
);
`;

const UPSERT_ROLLUP = `
INSERT INTO aid_rollup (
  hour_bucket, aid, domain, model_group,
  injected, skipped, tok_injected, est_tok_saved, requests
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(hour_bucket, aid, domain, model_group) DO UPDATE SET
  injected = excluded.injected,
  skipped = excluded.skipped,
  tok_injected = excluded.tok_injected,
  est_tok_saved = excluded.est_tok_saved,
  requests = excluded.requests
`;

export const AID_BASIS = "finding.injection-final@v2";
/** Honest byte-derived token estimate (labeled as an estimate everywhere). */
export const tokensEstimate = (bytes: number): number => Math.ceil(bytes / 4);

/** Aids ledger: buckle-local WAL sqlite in the same db file as the usage
 *  ledger (W133 wiring). Rollup recomputes complete hour buckets from the
 *  event log (SET semantics — safe to re-run; one buckle owns the buckets). */
export class AidsLedger {
	private readonly db: Database;

	constructor(
		path: string,
		private readonly now: () => Date = () => new Date(),
	) {
		this.db = new Database(path, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
		// Pre-W4 databases lack the expand ledger's served_model column;
		// CREATE TABLE IF NOT EXISTS never amends an existing table.
		try {
			this.db.exec("ALTER TABLE aid_events ADD COLUMN served_model TEXT");
		} catch {
			// column already present (fresh schema or migrated)
		}
	}

	/** Record one decision. Duplicate event_id → null (idempotent). */
	record(ev: AidEventInput): AidEventRow | null {
		const ts = ev.ts || this.now().getTime();
		const fp = ev.repo_root ? repoFp(ev.repo_root) : "";
		const event_id = new Bun.CryptoHasher("sha256")
			.update(
				`${ts}|${ev.aid}|${ev.decision}|${ev.skip_reason ?? ""}|${fp}|${ev.sid ?? ""}|${ev.work_item ?? ""}|${ev.packet_id ?? ""}|${ev.served_model ?? ""}|${ev.tokens_injected ?? 0}`,
			)
			.digest("hex")
			.slice(0, 16);
		try {
			this.db
				.query(
					`INSERT INTO aid_events (
             event_id, ts, aid, decision, skip_reason, domain, repo_fp,
             sid, work_item, packet_id, served_model, tokens_injected, est_tok_saved,
             rows_total, rows_verified, rows_doc_covered, rows_unverified, basis
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					event_id,
					ts,
					ev.aid,
					ev.decision,
					ev.skip_reason ?? null,
					ev.domain ?? "",
					fp,
					ev.sid ?? null,
					ev.work_item ?? null,
					ev.packet_id ?? null,
					ev.served_model ?? null,
					ev.tokens_injected ?? 0,
					ev.est_tok_saved ?? null, // NULL at event time — the law
					ev.rows?.total ?? 0,
					ev.rows?.verified ?? 0,
					ev.rows?.doc_covered ?? 0,
					ev.rows?.unverified ?? 0,
					ev.basis ?? AID_BASIS,
				);
			const row = this.db
				.query("SELECT id FROM aid_events WHERE event_id = ?")
				.get(event_id) as { id: number };
			return { ...ev, id: row.id, event_id, repo_fp: fp, ts } as AidEventRow;
		} catch {
			return null; // UNIQUE hit — already recorded
		}
	}

	/** Aggregate events into complete hour buckets (last `hours`).
	 *  model_group is "all" except expand (W4), whose events carry the REAL
	 *  serving model — a rollup never claims a model the aid didn't serve.
	 *  Caller-served aids fire at dispatch, pre-routing; token outcomes join
	 *  by (sid → actor, hour) — never model. */
	rollup(hours = 24, nowMs?: number): number {
		const to = Math.floor((nowMs ?? this.now().getTime()) / 3_600_000);
		const from = to - hours + 1;
		const rows = this.db
			.query(
				`SELECT (ts / 3600000) * 3600000 AS bucket, aid, domain,
                COALESCE(served_model, 'all') AS model_group,
                SUM(decision = 'injected') AS injected,
                SUM(decision = 'skipped') AS skipped,
                SUM(tokens_injected) AS tok_injected,
                COUNT(*) AS requests
         FROM aid_events WHERE ts >= ? AND ts < ?
         GROUP BY bucket, aid, domain, model_group`,
			)
			.all(from * 3_600_000, (to + 1) * 3_600_000) as Array<{
			bucket: number;
			aid: string;
			domain: string;
			model_group: string;
			injected: number;
			skipped: number;
			tok_injected: number;
			requests: number;
		}>;
		for (const r of rows) {
			this.db
				.query(UPSERT_ROLLUP)
				.run(
					r.bucket,
					r.aid,
					r.domain,
					r.model_group,
					r.injected ?? 0,
					r.skipped ?? 0,
					r.tok_injected ?? 0,
					0,
					r.requests ?? 0,
				);
		}
		return rows.length;
	}

	rollupRows(hours = 24): Array<Record<string, unknown>> {
		const from =
			(Math.floor(this.now().getTime() / 3_600_000) - hours + 1) * 3_600_000;
		return this.db
			.query(
				"SELECT * FROM aid_rollup WHERE hour_bucket >= ? ORDER BY hour_bucket DESC, aid",
			)
			.all(from) as Array<Record<string, unknown>>;
	}

	/** Raw events since a watermark (ms) — the harvest pull seam. */
	eventsSince(sinceMs: number, limit = 1000): Array<Record<string, unknown>> {
		return this.db
			.query("SELECT * FROM aid_events WHERE ts > ? ORDER BY ts LIMIT ?")
			.all(sinceMs, limit) as Array<Record<string, unknown>>;
	}

	status(): Record<string, unknown> {
		const s = this.db
			.query(
				`SELECT COUNT(*) AS n,
                SUM(decision = 'injected') AS injected,
                SUM(decision = 'skipped') AS skipped,
                SUM(tokens_injected) AS tok_injected,
                MAX(ts) AS last_ts
         FROM aid_events`,
			)
			.get() as Record<string, unknown>;
		return s;
	}

	close(): void {
		this.db.close();
	}
}
