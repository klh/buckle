// src/gov/budgets.ts — W141 rpm/tpm budgets: simple in-process counters with
// a periodic flush into the W132 budget_state durable half (upsert-ADD, so a
// retried batch can never lose counts; window_start moves to the flusher's
// value so a rolled window restarts the count honestly). W143 optimizes to
// O(1) + async flush; the ADMISSION approximation (input reservation =
// ceil(bodyBytes/4)) is deliberate W141 scope — real usage threading is W143.
import type { Database } from "bun:sqlite";

export interface BudgetLimits {
	rpm: number | null;
	tpm: number | null;
}

interface Win {
	window: string;
	reqs: number;
	tks: number;
	flushedReqs: number;
	flushedTks: number;
}

/** Minute-window id: `YYYY-MM-DDTHH:MM` in UTC. */
export function windowOf(nowMs: number): string {
	return new Date(nowMs).toISOString().slice(0, 16);
}

/** Seconds until the current minute window rolls over (>=1, jitter added by
 *  the caller per the LiteLLM retry-after pattern). */
export function windowRemainderS(nowMs: number): number {
	const s = nowMs / 1000;
	return Math.max(1, Math.ceil(60 - (s % 60)));
}

/** What admission saw, for the http-citizenship rate-limit trio: usage
 *  AFTER this request's reservation, and the window's honest edges. */
export interface BudgetView {
	usedReqs: number;
	usedTks: number;
	/** Seconds until the minute window rolls (>=1). */
	resetS: number;
	/** Unix epoch seconds of the window's end (de-facto x- family). */
	resetEpochS: number;
}

/** Effective limit = min(key limit, team ceiling); null = unbounded. */
export function effectiveLimit(
	key: BudgetLimits,
	ceiling: BudgetLimits | null,
): BudgetLimits {
	const minN = (a: number | null, b: number | null): number | null =>
		a === null ? b : b === null ? a : Math.min(a, b);
	return {
		rpm: minN(key.rpm, ceiling?.rpm ?? null),
		tpm: minN(key.tpm, ceiling?.tpm ?? null),
	};
}

const UPSERT_STATE = `INSERT INTO budget_state (
  key_id, window, used_rpm, used_tpm, window_start
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(key_id, window) DO UPDATE SET
  used_rpm = used_rpm + excluded.used_rpm,
  used_tpm = used_tpm + excluded.used_tpm,
  window_start = excluded.window_start`;

export class Budgets {
	private readonly wins = new Map<string, Win>();
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly db: Database,
		private readonly now: () => number = Date.now,
	) {}

	startFlushTimer(ms = 5000): void {
		if (this.timer !== null) return;
		const t = setInterval(() => this.flush(), ms);
		t.unref?.();
		this.timer = t;
	}

	stopFlushTimer(): void {
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
	}

	/** Admission check + request count. Denial returns retry-after seconds
	 *  (window remainder + U[0,1) jitter — LiteLLM retry-after semantics);
	 *  both arms carry the W155 BudgetView so the gate stamps the
	 *  rate-limit trio without a second counter read. */
	check(
		keyId: string,
		limits: BudgetLimits,
		bodyBytes: number,
	):
		| { ok: true; view: BudgetView }
		| { ok: false; retryAfterS: number; view: BudgetView } {
		const t = this.now();
		const win = this.current(keyId, t);
		const view = (): BudgetView => ({
			usedReqs: win.reqs,
			usedTks: win.tks,
			resetS: windowRemainderS(t),
			resetEpochS: Math.floor(t / 60_000) * 60 + 60,
		});
		const estTks = Math.ceil(bodyBytes / 4);
		if (limits.rpm !== null && win.reqs + 1 > limits.rpm) {
			return {
				ok: false,
				retryAfterS: windowRemainderS(t) + Math.random(),
				view: view(),
			};
		}
		if (limits.tpm !== null && win.tks + estTks > limits.tpm) {
			return {
				ok: false,
				retryAfterS: windowRemainderS(t) + Math.random(),
				view: view(),
			};
		}
		win.reqs += 1;
		win.tks += estTks;
		return { ok: true, view: view() };
	}

	/** Release an admission reservation (denial after admit). */
	release(keyId: string): void {
		const win = this.wins.get(keyId);
		if (win === undefined) return;
		win.reqs = Math.max(0, win.reqs - 1);
	}

	/** Post-response usage — real tokens when W143 threads them through. */
	addUsage(keyId: string, requests: number, tokens: number): void {
		const win = this.current(keyId, this.now());
		win.reqs += requests;
		win.tks += tokens;
	}

	private current(keyId: string, t: number): Win {
		const label = windowOf(t);
		const win = this.wins.get(keyId);
		if (win !== undefined && win.window === label) return win;
		const fresh: Win = {
			window: label,
			reqs: 0,
			tks: 0,
			flushedReqs: 0,
			flushedTks: 0,
		};
		this.wins.set(keyId, fresh);
		return fresh;
	}

	/** Flush dirty deltas to budget_state (upsert-ADD); rows written. */
	flush(): number {
		let n = 0;
		for (const [keyId, win] of this.wins) {
			const dR = win.reqs - win.flushedReqs;
			const dT = win.tks - win.flushedTks;
			if (dR === 0 && dT === 0) continue;
			this.db.query(UPSERT_STATE).run(keyId, win.window, dR, dT, Date.now());
			win.flushedReqs = win.reqs;
			win.flushedTks = win.tks;
			n += 1;
		}
		return n;
	}

	/** Readback for admin/tests: current window counters. */
	snapshot(): Array<{ keyId: string; win: Win }> {
		return [...this.wins.entries()].map(([keyId, win]) => ({ keyId, win }));
	}
}
