// test/ledger-durability.test.ts — review #13 §1.3: a failed flush must
// requeue (the transaction rolled back), retry, and drop only after the
// bounded attempt count — every drop counted.
import { describe, expect, test } from "bun:test";
import { Ledger } from "../src/ledger.ts";

const rec = (in_tok: number): Parameters<Ledger["record"]>[0] => ({
	key: "",
	group: "g",
	model: "m",
	in_tok,
	out_tok: 0,
	cache_r: 0,
	cache_c: 0,
	requests: 1,
});

/** Make the next n transactions throw (the db handle is private). */
function failNext(l: Ledger, n: number): void {
	const db = (
		l as unknown as { db: { transaction: (f: () => void) => () => void } }
	).db;
	const real = db.transaction.bind(db);
	let left = n;
	db.transaction = (f) => {
		if (left > 0) {
			left--;
			return () => {
				throw new Error("SQLITE_BUSY (injected)");
			};
		}
		return real(f);
	};
}

describe("Ledger durability", () => {
	test("failed flush requeues; the next flush lands the rows", () => {
		const l = new Ledger(":memory:", undefined, { flushMs: 60_000 });
		l.record(rec(3));
		failNext(l, 1);
		l.flush();
		expect(l.flushFails).toBe(1);
		expect(l.pending()).toBe(1);
		expect(l.dropped).toBe(0);
		l.record(rec(4));
		const row = l.rows()[0] ?? {};
		expect(row.in_tok).toBe(7);
		expect(l.pending()).toBe(0);
		l.close();
	});

	test("audit ops keep INSERT→UPDATE order across a retry", () => {
		const l = new Ledger(":memory:", undefined, { flushMs: 60_000 });
		l.auditDecision({
			rid: "r1",
			ts: "2026-10-01T00:00:00.000Z",
			actor: "a",
			dialect: "openai",
			hint: "",
			candidates_seen: 1,
			candidates_top: "c",
			target_kind: null,
			target_host: null,
			target_port: null,
			target_model: null,
			decision: "policy",
			latency_class: "fast",
			tier: "SIMPLE",
			allow_cloud: false,
			error_code: null,
			why: "w",
		});
		failNext(l, 1);
		l.flush();
		l.auditOutcome("r1", { status: 200, duration_ms: 1, ok: true, err: null });
		const rows = l.auditRows();
		expect(rows.length).toBe(1);
		expect(rows[0]?.status).toBe(200);
		l.close();
	});

	test("drops only after maxFlushAttempts, counted + observed", () => {
		const seen: Array<[string, number]> = [];
		const l = new Ledger(":memory:", undefined, {
			flushMs: 60_000,
			maxFlushAttempts: 3,
			onDrop: (k, n) => seen.push([k, n]),
		});
		l.record(rec(1));
		l.record(rec(1));
		failNext(l, 3);
		l.flush();
		l.flush();
		expect(l.dropped).toBe(0);
		expect(l.pending()).toBe(2);
		l.flush();
		expect(l.dropped).toBe(2);
		expect(l.pending()).toBe(0);
		expect(seen).toEqual([["usage", 2]]);
		expect(l.rows().length).toBe(0);
		l.close();
	});

	test("close() drains through transient failures", () => {
		const path = `/tmp/buckle-ledger-dur-${Date.now()}.db`;
		const l = new Ledger(path, undefined, { flushMs: 60_000 });
		l.record(rec(5));
		failNext(l, 2);
		l.close();
		expect(l.dropped).toBe(0);
		const fresh = new Ledger(path);
		expect(fresh.rows()[0]?.in_tok).toBe(5);
		fresh.close();
	});
});
