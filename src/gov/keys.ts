// src/gov/keys.ts — W141 virtual keys on the W132 api_keys shape: hash-at-rest
// (full sha-256 hex, UNIQUE), key_id = the 12-char truncated sha the ledger
// already uses for route_audit.actor / router_usage.key — audit joins with
// zero handler changes. Raw material exists exactly once: the issue response.
import type { Database } from "bun:sqlite";
import { scopesToStorage } from "./scopes.ts";

export interface KeyRow {
	key_id: string;
	key_hash: string;
	jti: string | null;
	name: string | null;
	team: string | null;
	actor: string | null;
	token_type: string;
	parent_key_id: string | null;
	scopes: string | null;
	rpm_limit: number | null;
	tpm_limit: number | null;
	expires_at: number | null;
	rotated_at: number | null;
	revoked_at: number | null;
	created_at: number;
}

export interface IssueSpec {
	name: string;
	team: string | null;
	scopes: string[];
	rpmLimit: number | null;
	tpmLimit: number | null;
	expiresInS: number | null;
	actor: string;
}

export interface VerifyOk {
	ok: true;
	key: KeyRow;
}

export interface VerifyErr {
	ok: false;
	code: string;
	why: string;
}

const PREFIX = "bksk_";

/** sha-256 hex of the raw token — the api_keys.key_hash storage form. */
export function hashKey(raw: string): string {
	return new Bun.CryptoHasher("sha256").update(raw).digest("hex");
}

const INSERT_KEY = `INSERT INTO api_keys (
  key_id, key_hash, jti, name, team, actor, token_type, parent_key_id,
  scopes, rpm_limit, tpm_limit, expires_at, rotated_at, revoked_at, created_at
) VALUES (?, ?, ?, ?, ?, ?, 'access', NULL, ?, ?, ?, ?, NULL, NULL, ?)`;

export class KeyStore {
	private readonly db: Database;
	private readonly byHash: ReturnType<Database["query"]>;

	constructor(db: Database) {
		this.db = db;
		this.byHash = db.query(
			"SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL",
		);
	}

	/** Mint one key: raw material returned ONCE (never stored), hash at rest.
	 *  key_id = the 12-char truncated hash — the ledger join convention. */
	issue(spec: IssueSpec): { keyId: string; key: string; row: KeyRow } {
		const raw = `${PREFIX}${Bun.randomUUIDv7().replaceAll("-", "")}`;
		const h = hashKey(raw);
		const keyId = h.slice(0, 12);
		const now = Date.now();
		const expiresAt =
			spec.expiresInS === null ? null : now + spec.expiresInS * 1000;
		this.db
			.query(INSERT_KEY)
			.run(
				keyId,
				h,
				`k${h.slice(12, 24)}`,
				spec.name,
				spec.team,
				spec.actor,
				scopesToStorage(spec.scopes),
				spec.rpmLimit,
				spec.tpmLimit,
				expiresAt,
				now,
			);
		return { keyId, key: raw, row: this.byHash.get(h) as KeyRow };
	}

	/** Raw bearer → key row, or a stable machine-readable rejection. */
	verify(raw: string): VerifyOk | VerifyErr {
		const h = hashKey(raw);
		const row = this.db
			.query("SELECT * FROM api_keys WHERE key_hash = ?")
			.get(h) as KeyRow | null;
		if (row === null)
			return { ok: false, code: "buckle.invalid_key", why: "unknown key" };
		if (row.revoked_at !== null)
			return { ok: false, code: "buckle.key_revoked", why: "key revoked" };
		if (row.expires_at !== null && row.expires_at <= Date.now())
			return { ok: false, code: "buckle.key_expired", why: "key expired" };
		return { ok: true, key: row };
	}

	/** Per-token revocation — a plain UPDATE the deltas triggers already see. */
	revoke(keyId: string): boolean {
		const n = this.db
			.query(
				"UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL",
			)
			.run(Date.now(), keyId).changes;
		return n > 0;
	}

	/** The issued|revoked|rejected auth-event ledger (W149 adds refresh|rotate). */
	recordAuthEvent(
		actor: string,
		event: "issued" | "revoked" | "rejected",
		jti: string | null,
		via: "api_key" | "jwt" | "root",
	): void {
		this.db
			.query(
				"INSERT INTO auth_events (ts, actor, event, jti, via) VALUES (?, ?, ?, ?, ?)",
			)
			.run(Date.now(), actor, event, jti, via);
	}

	/** Listing for the admin API — never exposes key_hash. */
	listKeys(): Array<Omit<KeyRow, "key_hash">> {
		return this.db
			.query(
				"SELECT key_id, jti, name, team, actor, token_type, parent_key_id, scopes, rpm_limit, tpm_limit, expires_at, rotated_at, revoked_at, created_at FROM api_keys ORDER BY created_at",
			)
			.all() as Array<Omit<KeyRow, "key_hash">>;
	}

	// ─── teams: membership container + per-team budget ceilings (W141) ───

	upsertTeam(spec: {
		teamId: string;
		name: string;
		department: string | null;
		rpmCeiling: number | null;
		tpmCeiling: number | null;
	}): void {
		this.db
			.query(
				"INSERT INTO teams (team_id, name, department, rpm_ceiling, tpm_ceiling, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(team_id) DO UPDATE SET name = excluded.name, department = excluded.department, rpm_ceiling = excluded.rpm_ceiling, tpm_ceiling = excluded.tpm_ceiling",
			)
			.run(
				spec.teamId,
				spec.name,
				spec.department,
				spec.rpmCeiling,
				spec.tpmCeiling,
				Date.now(),
			);
	}

	/** Ceiling lookup: null = no ceiling (key limits alone apply). */
	teamCeilings(
		teamId: string,
	): { rpm: number | null; tpm: number | null } | null {
		const r = this.db
			.query("SELECT rpm_ceiling, tpm_ceiling FROM teams WHERE team_id = ?")
			.get(teamId) as {
			rpm_ceiling: number | null;
			tpm_ceiling: number | null;
		} | null;
		return r === null ? null : { rpm: r.rpm_ceiling, tpm: r.tpm_ceiling };
	}

	listTeams(): Array<Record<string, unknown>> {
		return this.db.query("SELECT * FROM teams ORDER BY team_id").all() as Array<
			Record<string, unknown>
		>;
	}
}
