// test/cooldown.test.ts — ported retry-after math (both header forms).
import { describe, expect, test } from "bun:test";
import { retryAfterS, retryDelayS } from "../src/cooldown.ts";

describe("retryDelayS", () => {
	test("upstream retry-after honored (+ jitter)", () => {
		expect(retryDelayS(0, 3.5, () => 0, 8)).toBe(3.5);
		expect(retryDelayS(0, 3.5, () => 0.5, 8)).toBe(4);
	});

	test("absent header → capped exponential + jitter", () => {
		expect(retryDelayS(0, null, () => 0, 8)).toBe(1);
		expect(retryDelayS(1, null, () => 0, 8)).toBe(2);
		expect(retryDelayS(5, null, () => 0, 8)).toBe(8);
	});

	test("absent header: exponential + U[0,1) jitter added", () => {
		// attempt 3: cap 8, plus jitter 0.5
		expect(retryDelayS(3, null, () => 0.5, 8)).toBe(8.5);
	});
});

describe("retryAfterS", () => {
	test("delta-seconds form", () => {
		const h = new Headers({ "retry-after": "7" });
		expect(retryAfterS(h, () => 1000)).toBe(7);
	});

	test("HTTP-date form", () => {
		const h = new Headers({ "retry-after": new Date(5000).toUTCString() });
		expect(retryAfterS(h, () => 1000)).toBe(4);
	});

	test("absent header → null", () => {
		expect(retryAfterS(new Headers(), () => 1000)).toBeNull();
	});
});
