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

/** One pending audit operation, applied in order at flush time (the
 *  decision INSERT rides ahead of its outcome UPDATE — order is the join). */
type AuditOp =
	| { t: "ins"; row: RouteAuditDecision }
	| { t: "upd"; rid: string; out: RouteAuditOutcome };

export interface LedgerOptions {
	/** async flush cadence (W143 speed §3; default 5s) */
	flushMs?: number;
	/** flush trigger by pending rows (default 256) */
	flushRows?: number;
	/** flush attempts a row survives before it is dropped (default 5) */
	maxFlushAttempts?: number;
	/** drop observer — the servicemon counter seam (buckle_ledger_dropped_total) */
	onDrop?: (kind: "usage" | "audit", n: number) => void;
}

/** A ring entry with its failed-flush count (bounded retry). */
type Pending<T> = { v: T; tries: number };

export class Ledger {
	private readonly db: Database;
	private readonly upsert: ReturnType<Database["query"]>;
	private readonly flushMs: number;
	private readonly flushRows: number;
	private readonly maxAttempts: number;
	private readonly onDrop?: (kind: "usage" | "audit", n: number) => void;
	private usageRing: Array<Pending<UsageRecord & { bucket: string }>> = [];
	private auditRing: Array<Pending<AuditOp>> = [];
	private timer: ReturnType<typeof setInterval> | null = null;
	private flushQueued = false;
	/** flush transactions that threw — the fire-and-forget counter. */
	flushFails = 0;
	/** rows dropped after maxFlushAttempts failed flushes (usage + audit). */
	dropped = 0;

	constructor(
		path: string,
		private readonly now: () => Date = () => new Date(),
		opts: LedgerOptions = {},
	) {
		this.db = new Database(path, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
		this.upsert = this.db.query(UPSERT);
		this.flushMs = opts.flushMs ?? 5000;
		this.flushRows = opts.flushRows ?? 256;
		this.maxAttempts = Math.max(1, opts.maxFlushAttempts ?? 5);
		this.onDrop = opts.onDrop;
		this.timer = setInterval(() => this.flush(), this.flushMs);
		// never holds the process open (bun test, the bench harness)
		this.timer.unref?.();
	}

	/** Upsert-add into the hour bucket for now(): enqueued (bounded by the
	 *  5s timer / the row threshold — never on the request's stack). */
	record(rec: UsageRecord): void {
		const bucket = `${this.now().toISOString().slice(0, 13)}:00`;
		this.usageRing.push({ v: { ...rec, bucket }, tries: 0 });
		if (this.usageRing.length >= this.flushRows) this.flushSoon();
	}

	/** Defer one flush off the caller's stack (the threshold trigger). */
	private flushSoon(): void {
		if (this.flushQueued) return;
		this.flushQueued = true;
		const t = setTimeout(() => {
			this.flushQueued = false;
			this.flush();
		}, 0);
		t.unref?.();
	}

	/** One transaction for everything pending (W143 speed §3): usage upserts
	 *  then audit ops in arrival order. Failure never throws (the W140
	 *  fire-and-forget contract) but never loses rows silently either: the
	 *  transaction rolled back, so the batch is requeued ahead of newer rows
	 *  and retried; a row is dropped (counted in `dropped` + onDrop) only
	 *  after maxFlushAttempts failed flushes. */
	flush(): void {
		const usage = this.usageRing;
		const audit = this.auditRing;
		if (usage.length === 0 && audit.length === 0) return;
		this.usageRing = [];
		this.auditRing = [];
		try {
			this.db.transaction(() => {
				for (const { v: r } of usage)
					this.upsert.run(
						r.bucket,
						r.key,
						r.group,
						r.model,
						r.in_tok,
						r.out_tok,
						r.cache_r,
						r.cache_c,
						r.requests,
					);
				for (const { v: op } of audit) {
					if (op.t === "ins") this.insertAudit(op.row);
					else this.updateAudit(op.rid, op.out);
				}
			})();
		} catch {
			this.flushFails++;
			this.usageRing = [...this.requeue("usage", usage), ...this.usageRing];
			this.auditRing = [...this.requeue("audit", audit), ...this.auditRing];
		}
	}

	/** Failed batch → survivors (tries+1 < max) for the ring head; the rest
	 *  are dropped and counted. */
	private requeue<T>(
		kind: "usage" | "audit",
		batch: Array<Pending<T>>,
	): Array<Pending<T>> {
		const keep: Array<Pending<T>> = [];
		let lost = 0;
		for (const p of batch) {
			if (p.tries + 1 >= this.maxAttempts) lost++;
			else keep.push({ v: p.v, tries: p.tries + 1 });
		}
		if (lost > 0) {
			this.dropped += lost;
			this.onDrop?.(kind, lost);
		}
		return keep;
	}

	/** Rows waiting for the next flush (usage + audit ops). */
	pending(): number {
		return this.usageRing.length + this.auditRing.length;
	}

	/** Read-back for tests / status inspection. Read barrier: pending rows
	 *  flush first, so readers never see stale ring state. */
	rows(): Array<Record<string, unknown>> {
		this.flush();
		const stmt = this.db.query("SELECT * FROM router_usage");
		return stmt.all() as Array<Record<string, unknown>>;
	}

	// ─── route_audit (W136 §6): one decision row per request, joined by rid
	// to the outcome written after completion. Fire-and-forget WAL inserts —
	// a failed audit write never fails the route (belt precedent). ───

	/** Insert the decision row (target already known at dispatch): enqueued;
	 *  the flush applies INSERTs and UPDATEs in arrival order. */
	auditDecision(row: RouteAuditDecision): void {
		this.auditRing.push({ v: { t: "ins", row }, tries: 0 });
		if (this.auditRing.length >= this.flushRows) this.flushSoon();
	}

	/** The flush-time INSERT (extracted from the old inline body). */
	private insertAudit(row: RouteAuditDecision): void {
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
	}

	/** Update the decision row with the outcome (joined by rid): enqueued. */
	auditOutcome(rid: string, out: RouteAuditOutcome): void {
		this.auditRing.push({ v: { t: "upd", rid, out }, tries: 0 });
	}

	/** The flush-time UPDATE (extracted from the old inline body). */
	private updateAudit(rid: string, out: RouteAuditOutcome): void {
		this.db
			.query(
				"UPDATE route_audit SET status = ?, duration_ms = ?, ok = ?, err = ? WHERE rid = ?",
			)
			.run(out.status, out.duration_ms, out.ok ? 1 : 0, out.err, rid);
	}

	/** Read-back for tests / dashboards. Read barrier: pending audit ops
	 *  flush first (INSERTs ahead of their UPDATEs — order preserved). */
	auditRows(): Array<Record<string, unknown>> {
		this.flush();
		return this.db
			.query("SELECT * FROM route_audit ORDER BY ts")
			.all() as Array<Record<string, unknown>>;
	}

	close(): void {
		// drain: each failed flush ages the batch, so this ends within
		// maxAttempts passes — survivors land, the rest are counted drops
		for (let i = 0; i < this.maxAttempts && this.pending() > 0; i++)
			this.flush();
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
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
