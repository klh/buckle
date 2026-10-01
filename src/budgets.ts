// src/budgets.ts — O(1) in-process budget books (W143 speed §3): rpm/tpm as
// 60-slot per-second rings with incrementally-maintained rolling sums, the
// token budget as one integer per key. A check is a few field loads plus a
// compare — no allocation beyond the verdict object, no scan, no I/O in the
// check. Limits come from the policy YAML `budgets:` block (buckle-extension
// knob; belt ignores unknown keys); key "*" is the default book, a named key
// (the sha-prefix ledger id) overrides it. Enforcement wiring is W141's
// surface — this module is the constant-time engine it can adopt.
export interface BudgetLimit {
	rpm?: number; // max requests per rolling 60s
	tpm?: number; // max tokens per rolling 60s
	max_tokens?: number; // lifetime token budget for the key
}

export type BudgetLimits = Record<string, BudgetLimit>;

export type BudgetVerdict =
	| { ok: true }
	| { ok: false; code: "rate_rpm" | "rate_tpm" | "budget_spent"; why: string };

const RING = 60;

interface Book {
	head: number;
	reqSlots: Int32Array;
	tokSlots: Int32Array;
	reqSum: number;
	tokSum: number;
	lastSec: number;
	remaining: number | null; // null = unlimited
}

const freshBook = (limit: BudgetLimit): Book => ({
	head: 0,
	reqSlots: new Int32Array(RING),
	tokSlots: new Int32Array(RING),
	reqSum: 0,
	tokSum: 0,
	lastSec: Math.floor(Date.now() / 1000),
	remaining: limit.max_tokens ?? null,
});

/** Slide the ring to `sec`, zeroing evicted slots and keeping sums exact. */
function advance(b: Book, sec: number): void {
	const gap = sec - b.lastSec;
	if (gap <= 0) return;
	if (gap >= RING) {
		b.reqSlots.fill(0);
		b.tokSlots.fill(0);
		b.reqSum = 0;
		b.tokSum = 0;
	} else {
		for (let i = 0; i < gap; i++) {
			const h = b.head;
			b.reqSum -= b.reqSlots[h] ?? 0;
			b.tokSum -= b.tokSlots[h] ?? 0;
			b.reqSlots[h] = 0;
			b.tokSlots[h] = 0;
			b.head = (h + 1) % RING;
		}
	}
	b.lastSec = sec;
}

/** The books: one Book per key, created lazily on first sight. */
export class BudgetBooks {
	private readonly books = new Map<string, Book>();
	constructor(
		private readonly limits: BudgetLimits = {},
		private readonly now: () => number = Date.now,
	) {}

	/** The book for key — the named key's limit wins over the "*" default. */
	private bookFor(key: string): { book: Book; limit: BudgetLimit } | null {
		const base = this.limits[key] ?? this.limits["*"];
		if (!base) return null;
		let book = this.books.get(key);
		if (!book) {
			book = freshBook(base);
			this.books.set(key, book);
		}
		return { book, limit: base };
	}

	/** Constant-time gate: advance the ring, compare sums. No I/O. */
	check(key: string): BudgetVerdict {
		const entry = this.bookFor(key);
		if (!entry) return { ok: true };
		advance(entry.book, Math.floor(this.now() / 1000));
		const { book, limit } = entry;
		if (limit.rpm !== undefined && book.reqSum >= limit.rpm)
			return {
				ok: false,
				code: "rate_rpm",
				why: `rpm ${String(limit.rpm)} exceeded for this window`,
			};
		if (limit.tpm !== undefined && book.tokSum >= limit.tpm)
			return {
				ok: false,
				code: "rate_tpm",
				why: `tpm ${String(limit.tpm)} exceeded for this window`,
			};
		if (book.remaining !== null && book.remaining <= 0)
			return {
				ok: false,
				code: "budget_spent",
				why: `token budget spent for key ${key}`,
			};
		return { ok: true };
	}

	/** +1 request in the rolling window (call after a passing check). */
	spendRequest(key: string): void {
		const entry = this.bookFor(key);
		if (!entry) return;
		advance(entry.book, Math.floor(this.now() / 1000));
		const h = entry.book.head;
		entry.book.reqSlots[h] = (entry.book.reqSlots[h] ?? 0) + 1;
		entry.book.reqSum += 1;
	}

	/** Tokens into the rolling window + off the lifetime budget. */
	spendTokens(key: string, tokens: number): void {
		const entry = this.bookFor(key);
		if (!entry || tokens <= 0) return;
		advance(entry.book, Math.floor(this.now() / 1000));
		const h = entry.book.head;
		entry.book.tokSlots[h] = (entry.book.tokSlots[h] ?? 0) + tokens;
		entry.book.tokSum += tokens;
		if (entry.book.remaining !== null) entry.book.remaining -= tokens;
	}
}
