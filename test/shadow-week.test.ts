// test/shadow-week.test.ts — the W144 shadow monitor's pure logic: day key,
// torn-line-tolerant parsing, the scenario-keyed diff flags, the bounded log.
import { describe, expect, test } from "bun:test";
import {
	boundKeep,
	dayKey,
	diffDay,
	parseBenchRows,
	type BenchRow,
} from "../bin/shadow-week.ts";

const row = (over: Partial<BenchRow>): BenchRow => ({
	scenario: "stream-short",
	gate: true,
	pass: true,
	p50_ms: 0.15,
	p95_ms: 0.47,
	byte_identity_pct: 100,
	...over,
});

describe("dayKey", () => {
	test("pads month and day", () => {
		expect(dayKey(new Date(2026, 9, 1))).toBe("2026-10-01");
		expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
	});
});

describe("parseBenchRows", () => {
	test("parses lines, tolerates a torn final line", () => {
		const text = [
			JSON.stringify({ scenario: "stream-short", p50_ms: 0.1 }),
			'{"scenario":"torn","p50',
			"",
		].join("\n");
		const rows = parseBenchRows(text);
		expect(rows.length).toBe(1);
		expect(rows[0]?.scenario).toBe("stream-short");
	});
});

describe("diffDay", () => {
	test("first day records, never flags", () => {
		const out = diffDay([row({})], []);
		expect(out.length).toBe(1);
		expect(out[0]?.flags.length).toBe(0);
	});

	test("gate fail and budget breach are hard flags", () => {
		const bad = row({ pass: false, p50_ms: 6, p95_ms: 16 });
		const out = diffDay([bad], [row({})]);
		const f = out.find((x) => x.scenario === "stream-short");
		expect(f?.hard).toBe(true);
		expect(f?.flags).toContain("gate-fail");
		expect(f?.flags).toContain("gate-budget");
	});

	test("byte identity < 100 is hard, mid-stream death excepted", () => {
		const out = diffDay([row({ byte_identity_pct: 99.9 })], [row({})]);
		expect(out[0]?.flags).toContain("byte-identity");
		const mid = diffDay(
			[row({ scenario: "failover-mid-stream", byte_identity_pct: 0 })],
			[row({ scenario: "failover-mid-stream", byte_identity_pct: 0 })],
		);
		expect(mid[0]?.flags).not.toContain("byte-identity");
	});

	test("tolerance: >2x prior day p50/p95 is a soft flag", () => {
		const out = diffDay(
			[row({ p50_ms: 0.5, p95_ms: 0.5 })],
			[row({ p50_ms: 0.1, p95_ms: 0.1 })],
		);
		const f = out[0];
		expect(f?.flags.some((x) => x.startsWith("tolerance:p50"))).toBe(true);
		expect(f?.flags.some((x) => x.startsWith("tolerance:p95"))).toBe(true);
		expect(f?.hard).toBe(false);
	});

	test("litellm availability transitions flag softly", () => {
		const down = diffDay(
			[row({ scenario: "litellm-nonstream", gate: false, available: false })],
			[row({ scenario: "litellm-nonstream", gate: false, available: true })],
		);
		expect(down[0]?.flags).toContain("litellm-unavailable-was-up");
	});

	test("a scenario gone missing vs prior day flags softly", () => {
		const out = diffDay([row({})], [row({ scenario: "must-503" })]);
		const gone = out.find((x) => x.scenario === "must-503");
		expect(gone?.flags).toEqual(["missing-scenario"]);
	});
});

describe("boundKeep", () => {
	test("keeps the 7-day window, drops stale and torn lines", () => {
		const now = Date.now();
		const lines = [
			JSON.stringify({ ts: new Date(now - 86_400_000).toISOString() }),
			JSON.stringify({ ts: new Date(now - 8 * 86_400_000).toISOString() }),
			"not json",
			JSON.stringify({ no_ts: true }),
		];
		const kept = boundKeep(lines, now);
		expect(kept.length).toBe(1);
	});
});
