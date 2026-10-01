// test/ledger.test.ts — upsert-add semantics for the hour-bucket ledger.
import { describe, expect, test } from "bun:test";
import { Ledger } from "../src/ledger.ts";

describe("Ledger", () => {
	test("upsert-adds within one hour bucket", () => {
		const db = new Ledger(":memory:");
		const rec = (in_tok: number, out_tok: number): void => {
			db.record({
				key: "",
				group: "g",
				model: "m",
				in_tok,
				out_tok,
				cache_r: 2,
				cache_c: 1,
				requests: 1,
			});
		};
		rec(10, 5);
		rec(3, 4);
		const row = db.rows()[0] ?? {};
		expect(db.rows().length).toBe(1);
		expect(row.in_tok).toBe(13);
		expect(row.out_tok).toBe(9);
		expect(row.cache_r).toBe(4);
		expect(row.cache_c).toBe(2);
		expect(row.requests).toBe(2);
		db.close();
	});

	test("separate rows per (key, group, model)", () => {
		const db = new Ledger(":memory:");
		db.record({
			key: "k1",
			group: "g",
			model: "m",
			in_tok: 1,
			out_tok: 0,
			cache_r: 0,
			cache_c: 0,
			requests: 1,
		});
		db.record({
			key: "k2",
			group: "g",
			model: "m",
			in_tok: 2,
			out_tok: 0,
			cache_r: 0,
			cache_c: 0,
			requests: 1,
		});
		expect(db.rows().length).toBe(2);
		db.close();
	});

	test("hour bucket is the ISO hour of now()", () => {
		const db = new Ledger(":memory:", () => new Date("2026-10-01T12:34:56Z"));
		db.record({
			key: "",
			group: "g",
			model: "m",
			in_tok: 0,
			out_tok: 0,
			cache_r: 0,
			cache_c: 0,
			requests: 1,
		});
		const row = db.rows()[0] ?? {};
		expect(row.hour_bucket).toBe("2026-10-01T12:00");
		db.close();
	});
});
