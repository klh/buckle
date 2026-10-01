// src/ledger.ts — usage ledger: hour-bucket aggregate table, govdb-shaped,
// swap-ready for the W92 openStore binding later (statements live in one
// place; the binding swap changes the constructor, not the SQL shape).
// Key ids are a truncated SHA-256 of the bearer token — token material never
// touches the ledger (SECURITY: nothing hashable → empty string).
import { Database } from "bun:sqlite";

export interface UsageRecord {
	key: string;
	group: string;
	model: string;
	in_tok: number;
	out_tok: number;
	cache_r: number;
	cache_c: number;
	requests: number;
}

/** W136 §6 decision row (the outcome fields ride the same table row). */
export interface RouteAuditDecision {
	rid: string;
	ts: string;
	actor: string;
	dialect: string;
	hint: string;
	candidates_seen: number;
	candidates_top: string;
	target_kind: string | null;
	target_host: string | null;
	target_port: number | null;
	target_model: string | null;
	decision: string;
	latency_class: string;
	tier: string;
	allow_cloud: boolean;
	error_code: string | null;
	why: string;
}

export interface RouteAuditOutcome {
	status: number;
	duration_ms: number;
	ok: boolean;
	err: string | null;
}

const INSERT_AUDIT = `
INSERT INTO route_audit (
  rid, ts, actor, dialect, hint,
  candidates_seen, candidates_top,
  target_kind, target_host, target_port, target_model,
  decision, latency_class, tier, allow_cloud, error_code, why
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS router_usage (
  hour_bucket TEXT NOT NULL,
  key TEXT NOT NULL DEFAULT '',
  model_group TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  in_tok INTEGER NOT NULL DEFAULT 0,
  out_tok INTEGER NOT NULL DEFAULT 0,
  cache_r INTEGER NOT NULL DEFAULT 0,
  cache_c INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour_bucket, key, model_group, model)
);
CREATE TABLE IF NOT EXISTS route_audit (
  rid TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  dialect TEXT NOT NULL DEFAULT '',
  hint TEXT NOT NULL DEFAULT '',
  candidates_seen INTEGER NOT NULL DEFAULT 0,
  candidates_top TEXT NOT NULL DEFAULT '',
  target_kind TEXT, target_host TEXT, target_port INTEGER, target_model TEXT,
  decision TEXT NOT NULL DEFAULT '',
  latency_class TEXT NOT NULL DEFAULT 'unproven',
  tier TEXT NOT NULL DEFAULT '',
  allow_cloud INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  why TEXT NOT NULL DEFAULT '',
  status INTEGER, duration_ms INTEGER, ok INTEGER, err TEXT
);
`;

const UPSERT = `
INSERT INTO router_usage (
  hour_bucket, key, model_group, model,
  in_tok, out_tok, cache_r, cache_c, requests
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(hour_bucket, key, model_group, model) DO UPDATE SET
  in_tok = in_tok + excluded.in_tok,
  out_tok = out_tok + excluded.out_tok,
  cache_r = cache_r + excluded.cache_r,
  cache_c = cache_c + excluded.cache_c,
  requests = requests + excluded.requests
`;

export class Ledger {
	private readonly db: Database;
	private readonly upsert: ReturnType<Database["query"]>;

	constructor(
		path: string,
		private readonly now: () => Date = () => new Date(),
	) {
		this.db = new Database(path, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
		this.upsert = this.db.query(UPSERT);
	}

	/** Upsert-add into the hour bucket for now(). */
	record(rec: UsageRecord): void {
		const bucket = `${this.now().toISOString().slice(0, 13)}:00`;
		this.upsert.run(
			bucket,
			rec.key,
			rec.group,
			rec.model,
			rec.in_tok,
			rec.out_tok,
			rec.cache_r,
			rec.cache_c,
			rec.requests,
		);
	}

	/** Read-back for tests / status inspection. */
	rows(): Array<Record<string, unknown>> {
		const stmt = this.db.query("SELECT * FROM router_usage");
		return stmt.all() as Array<Record<string, unknown>>;
	}

	// ─── route_audit (W136 §6): one decision row per request, joined by rid
	// to the outcome written after completion. Fire-and-forget WAL inserts —
	// a failed audit write never fails the route (belt precedent). ───

	/** Insert the decision row (target already known at dispatch). */
	auditDecision(row: RouteAuditDecision): void {
		try {
			this.db
				.query(INSERT_AUDIT)
				.run(
					row.rid,
					row.ts,
					row.actor,
					row.dialect,
					row.hint,
					row.candidates_seen,
					row.candidates_top,
					row.target_kind,
					row.target_host,
					row.target_port,
					row.target_model,
					row.decision,
					row.latency_class,
					row.tier,
					row.allow_cloud ? 1 : 0,
					row.error_code,
					row.why,
				);
		} catch {
			// fire-and-forget
		}
	}

	/** Update the decision row with the outcome (joined by rid). */
	auditOutcome(rid: string, out: RouteAuditOutcome): void {
		try {
			this.db
				.query(
					"UPDATE route_audit SET status = ?, duration_ms = ?, ok = ?, err = ? WHERE rid = ?",
				)
				.run(out.status, out.duration_ms, out.ok ? 1 : 0, out.err, rid);
		} catch {
			// fire-and-forget
		}
	}

	/** Read-back for tests / dashboards. */
	auditRows(): Array<Record<string, unknown>> {
		return this.db
			.query("SELECT * FROM route_audit ORDER BY ts")
			.all() as Array<Record<string, unknown>>;
	}

	close(): void {
		this.db.close();
	}
}

/** Bearer token → truncated sha-256 hex id (12 chars). */
export function keyIdFromAuth(header: string | null): string {
	const m = /Bearer\s+(.+)/i.exec(header ?? "");
	if (!m) return "";
	return new Bun.CryptoHasher("sha256")
		.update(m[1] ?? "")
		.digest("hex")
		.slice(0, 12);
}
