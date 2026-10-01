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
