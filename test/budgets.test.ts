// test/budgets.test.ts — the O(1) in-process books: rolling 60-slot rings
// with exact running sums, one integer per key for the token budget; a check
// is field loads + compare, never I/O.
import { describe, expect, test } from "bun:test";
import { BudgetBooks } from "../src/budgets.ts";

const SEC = (n: number): number => 1_800_000_000_000 + n * 1000;

describe("BudgetBooks", () => {
	test("rpm: limit holds for the window, frees after it slides", () => {
		let sec = 0;
		const books = new BudgetBooks({ "*": { rpm: 3 } }, () => SEC(sec));
		for (let i = 0; i < 3; i++) {
			expect(books.check("k").ok).toBe(true);
			books.spendRequest("k");
		}
		const v = books.check("k");
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.code).toBe("rate_rpm");
		sec = 61; // the whole window slid out
		expect(books.check("k").ok).toBe(true);
	});

	test("tpm: tokens accumulate and free as the window slides", () => {
		let sec = 0;
		const books = new BudgetBooks({ "*": { tpm: 100 } }, () => SEC(sec));
		books.spendTokens("k", 100);
		const v = books.check("k");
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.code).toBe("rate_tpm");
		sec = 61;
		expect(books.check("k").ok).toBe(true);
	});

	test("budget: one integer, spent once, named key overrides '*'", () => {
		const books = new BudgetBooks(
			{
				"*": { max_tokens: 100 },
				spent: { max_tokens: 10 },
			},
			() => SEC(0),
		);
		expect(books.check("other").ok).toBe(true);
		books.spendTokens("spent", 10);
		const v = books.check("spent");
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.code).toBe("budget_spent");
		expect(books.check("other").ok).toBe(true);
		books.spendTokens("other", 99);
		expect(books.check("other").ok).toBe(true);
		books.spendTokens("other", 1);
		expect(books.check("other").ok).toBe(false);
	});

	test("check cost is flat in history (O(1) sanity)", () => {
		const books = new BudgetBooks({ "*": { rpm: 1_000_000 } });
		for (let k = 0; k < 200; k++) books.spendRequest(`key-${String(k)}`);
		const t0 = performance.now();
		for (let i = 0; i < 20_000; i++) books.check(`key-${String(i % 200)}`);
		const perCheckUs = ((performance.now() - t0) / 20_000) * 1000;
		expect(perCheckUs).toBeLessThan(5);
	});
});
