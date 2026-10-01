// test/gov-units.test.ts — W141 governance unit tests: scope inheritance,
// key issue/verify/revoke lifecycle with hash-at-rest, the deltas path in
// the local ledger, and budget windows with honest flush accounting.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	Budgets,
	effectiveLimit,
	windowOf,
	windowRemainderS,
} from "../src/gov/budgets.ts";
import { KeyStore, hashKey } from "../src/gov/keys.ts";
import { applyGovernanceSchema } from "../src/gov/schema.ts";
import {
	ALL_SCOPES,
	hasScope,
	parseScope,
	scopesToStorage,
} from "../src/gov/scopes.ts";

function govDb(): Database {
	const db = new Database(":memory:", { create: true });
	applyGovernanceSchema(db);
	return db;
}

describe("scopes", () => {
	test("WRITE_ implies READ_ on the same resource only", () => {
		expect(hasScope(["buckle:proxy:WRITE_"], "buckle:proxy:READ_")).toBe(true);
		expect(hasScope(["buckle:proxy:READ_"], "buckle:proxy:WRITE_")).toBe(false);
		expect(hasScope(["buckle:proxy:WRITE_"], "buckle:admin:READ_")).toBe(false);
		expect(hasScope([], "buckle:proxy:READ_")).toBe(false);
	});

	test("parse/storage round-trip drops invalid, keeps valid", () => {
		expect(parseScope("buckle:proxy:WRITE_")).toBe("buckle:proxy:WRITE_");
		expect(parseScope("buckle:proxy:ADMIN")).toBe(null);
		expect(
			scopesToStorage([
				"buckle:admin:WRITE_",
				"buckle:proxy:WRITE_",
				"buckle:proxy:WRITE_",
				"junk",
			]),
		).toBe("buckle:admin:WRITE_ buckle:proxy:WRITE_");
		expect(ALL_SCOPES).toHaveLength(4);
	});
});

describe("keys", () => {
	test("issue → verify → revoke lifecycle with hash-at-rest", () => {
		const ks = new KeyStore(govDb());
		const spec = {
			name: "t",
			team: "ops" as string | null,
			scopes: ["buckle:proxy:WRITE_"],
			rpmLimit: 10 as number | null,
			tpmLimit: null as number | null,
			expiresInS: null as number | null,
			actor: "tester",
		};
		const { keyId, key, row } = ks.issue(spec);
		expect(key.startsWith("bksk_")).toBe(true);
		expect(keyId).toBe(hashKey(key).slice(0, 12));
		expect(row.key_hash).toBe(hashKey(key));
		expect(ks.verify(key).ok).toBe(true);
		expect(ks.verify("bksk_unknown").ok).toBe(false);
		expect(ks.revoke(keyId)).toBe(true);
		const dead = ks.verify(key);
		expect(dead.ok).toBe(false);
		if (!dead.ok) expect(dead.code).toBe("buckle.key_revoked");
	});

	test("expired key rejected with a stable code", () => {
		const ks = new KeyStore(govDb());
		const { key } = ks.issue({
			name: "t",
			team: null,
			scopes: ["buckle:proxy:READ_"],
			rpmLimit: null,
			tpmLimit: null,
			expiresInS: -1,
			actor: "tester",
		});
		const dead = ks.verify(key);
		expect(dead.ok).toBe(false);
		if (!dead.ok) expect(dead.code).toBe("buckle.key_expired");
	});

	test("the deltas path: issue + revoke land in the deltas log", () => {
		const db = govDb();
		const ks = new KeyStore(db);
		const { keyId, key } = ks.issue({
			name: "t",
			team: "ops",
			scopes: ["buckle:proxy:WRITE_"],
			rpmLimit: 1,
			tpmLimit: null,
			expiresInS: null,
			actor: "tester",
		});
		ks.revoke(keyId);
		const rows = db
			.query("SELECT tbl, op FROM deltas WHERE tbl = 'api_keys' ORDER BY ts")
			.all() as Array<{ tbl: string; op: string }>;
		const ops = rows.map((r) => r.op);
		expect(ops).toContain("insert");
		expect(ops).toContain("update");
		expect(key.startsWith("bksk_")).toBe(true);
	});
});

describe("budgets", () => {
	function mkBudgets(now: () => number): {
		b: Budgets;
		db: Database;
	} {
		const db = govDb();
		return { b: new Budgets(db, now), db };
	}

	test("rpm denial at the limit, retry-after >= 1s", () => {
		const t0 = Date.UTC(2026, 9, 1, 12, 0, 0);
		const { b } = mkBudgets(() => t0);
		const limits = { rpm: 2, tpm: null };
		expect(b.check("k1", limits, 100).ok).toBe(true);
		expect(b.check("k1", limits, 100).ok).toBe(true);
		const third = b.check("k1", limits, 100);
		expect(third.ok).toBe(false);
		if (!third.ok) expect(third.retryAfterS).toBeGreaterThanOrEqual(1);
	});

	test("window rollover resets the count", () => {
		let t = Date.UTC(2026, 9, 1, 12, 0, 30);
		const { b } = mkBudgets(() => t);
		const limits = { rpm: 1, tpm: null };
		expect(b.check("k1", limits, 0).ok).toBe(true);
		expect(b.check("k1", limits, 0).ok).toBe(false);
		t += 61_000;
		expect(b.check("k1", limits, 0).ok).toBe(true);
	});

	test("flush writes budget_state upsert-ADD, no double count", () => {
		const t0 = Date.UTC(2026, 9, 1, 12, 0, 0);
		const { b, db } = mkBudgets(() => t0);
		const limits = { rpm: 100, tpm: null };
		b.check("k1", limits, 0);
		b.check("k1", limits, 0);
		expect(b.flush()).toBe(1);
		b.check("k1", limits, 0);
		expect(b.flush()).toBe(1);
		const row = db
			.query("SELECT used_rpm FROM budget_state WHERE key_id = 'k1'")
			.get() as { used_rpm: number };
		expect(row.used_rpm).toBe(3);
		expect(b.flush()).toBe(0);
	});

	test("window helpers: minute buckets and remainders", () => {
		const t0 = Date.UTC(2026, 9, 1, 12, 0, 0);
		expect(windowOf(t0)).toBe("2026-10-01T12:00");
		expect(windowRemainderS(t0 + 59_000)).toBeGreaterThanOrEqual(1);
		expect(windowRemainderS(t0)).toBeGreaterThanOrEqual(59);
	});

	test("team ceiling tightens the key limit via effectiveLimit", () => {
		const out = effectiveLimit({ rpm: 100, tpm: null }, { rpm: 3, tpm: null });
		expect(out.rpm).toBe(3);
	});
});
