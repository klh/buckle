// src/gov/schema.ts — W141 governance tables in the buckle ledger DB:
// govdb v8 shapes verbatim (hooks/lib/govdb.ts W132 block) so the W92
// openStore binding swap moves statements as-is, PLUS the deltas mirror —
// the audit trail IS the deltas log (W132 doctrine), so the same trigger
// loop govdb runs is created here over the local tables. Team ceilings ride
// guarded ALTERs (house idempotent pattern).
import type { Database } from "bun:sqlite";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
  key_id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  jti TEXT,
  name TEXT,
  team TEXT,
  actor TEXT,
  token_type TEXT NOT NULL DEFAULT 'access',
  parent_key_id TEXT,
  scopes TEXT,
  rpm_limit INTEGER,
  tpm_limit INTEGER,
  expires_at INTEGER,
  rotated_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash ON api_keys(key_hash);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_jti ON api_keys(jti);
CREATE TABLE IF NOT EXISTS teams (
  team_id TEXT PRIMARY KEY,
  name TEXT,
  department TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS budget_state (
  key_id TEXT NOT NULL,
  window TEXT NOT NULL,
  used_rpm INTEGER NOT NULL DEFAULT 0,
  used_tpm INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  PRIMARY KEY (key_id, window)
);
CREATE TABLE IF NOT EXISTS auth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT,
  event TEXT NOT NULL,
  jti TEXT,
  via TEXT
);
CREATE TABLE IF NOT EXISTS federation_cr_queue (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'declared',
  note TEXT,
  updated_at INTEGER,
  reported_at INTEGER
);
`;

/** (table, pk-expression, columns) — mirrors the govdb deltaTables entries. */
const DELTA_TABLES: Array<{ tbl: string; pk: string; cols: string[] }> = [
	{
		tbl: "api_keys",
		pk: "$.key_id",
		cols: [
			"key_id",
			"key_hash",
			"jti",
			"name",
			"team",
			"actor",
			"token_type",
			"parent_key_id",
			"scopes",
			"rpm_limit",
			"tpm_limit",
			"expires_at",
			"rotated_at",
			"revoked_at",
			"created_at",
		],
	},
	{
		tbl: "teams",
		pk: "$.team_id",
		cols: ["team_id", "name", "department", "created_at"],
	},
	{
		tbl: "budget_state",
		pk: "$.key_id || '/' || $.window",
		cols: ["key_id", "window", "used_rpm", "used_tpm", "window_start"],
	},
	{
		tbl: "auth_events",
		pk: "$.id",
		cols: ["id", "ts", "actor", "event", "jti", "via"],
	},
	{
		tbl: "federation_cr_queue",
		pk: "$.id",
		cols: [
			"id",
			"action",
			"target",
			"declared_at",
			"state",
			"note",
			"updated_at",
			"reported_at",
		],
	},
];

/** One deltas trigger (same shape as govdb's loop emits). */
function deltasTriggerSql(
	tbl: string,
	pk: string,
	cols: string[],
	op: "insert" | "update" | "delete",
): string {
	const R = op === "delete" ? "OLD" : "NEW";
	const img = (side: "OLD" | "NEW"): string =>
		`json_object(${cols.map((c) => `'${c}', ${side}.${c}`).join(", ")})`;
	const before = op === "insert" ? "NULL" : img("OLD");
	const after = op === "delete" ? "NULL" : img("NEW");
	return `CREATE TRIGGER IF NOT EXISTS deltas_${tbl}_${op} AFTER ${op.toUpperCase()} ON ${tbl} BEGIN INSERT INTO deltas (ts, tbl, op, pk, before, after) VALUES (strftime('%s','now') * 1000, '${tbl}', '${op}', ${pk.replaceAll("$.", `${R}.`)}, ${before}, ${after}); END`;
}

export function applyGovernanceSchema(db: Database): void {
	db.exec(SCHEMA_SQL);
	// the deltas mirror table (govdb has it; the local ledger needs its own)
	db.exec(
		"CREATE TABLE IF NOT EXISTS deltas (ts INTEGER NOT NULL, tbl TEXT NOT NULL, op TEXT NOT NULL, pk TEXT NOT NULL, before TEXT, after TEXT)",
	);
	// team ceilings (W141) — guarded ALTERs, idempotent on every open
	const cols = (
		db.query("SELECT name FROM pragma_table_info('teams')").all() as Array<{
			name: string;
		}>
	).map((r) => r.name);
	if (!cols.includes("rpm_ceiling"))
		db.run("ALTER TABLE teams ADD COLUMN rpm_ceiling INTEGER");
	if (!cols.includes("tpm_ceiling"))
		db.run("ALTER TABLE teams ADD COLUMN tpm_ceiling INTEGER");
	// the deltas mirror — guarded CREATEs, self-healing on every open
	for (const { tbl, pk, cols } of DELTA_TABLES)
		for (const op of ["insert", "update", "delete"] as const)
			db.run(deltasTriggerSql(tbl, pk, cols, op));
}
