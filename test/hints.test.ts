// test/hints.test.ts — the W96 grammar port: verbatim parse shapes, every
// rejection case with the named why, header seam (512 cap, duplicate
// refusal), and fit semantics.
import { describe, expect, test } from "bun:test";
import {
	hintFit,
	hintFromHeaders,
	hintTotal,
	parseHint,
	type RouteHint,
} from "../src/hints.ts";

const OK = (raw: string): RouteHint => {
	const r = parseHint(raw);
	if (!r.ok) throw new Error(`${raw}: ${r.why}`);
	return r.hint;
};

describe("grammar", () => {
	test("prefer local distill reasoning", () => {
		expect(OK("prefer local distill reasoning")).toEqual({
			verb: "prefer",
			location: { kind: "local" },
			tags: ["distill", "reasoning"],
		});
	});
	test("must cloud", () => {
		expect(OK("must cloud")).toEqual({
			verb: "must",
			location: { kind: "cloud" },
			tags: [],
		});
	});
	test("prefer host:box model:qwen* + tag", () => {
		const h = OK("prefer host:Box model:qwen* vision");
		expect(h.location).toEqual({ host: "Box" });
		expect(h.model).toBe("qwen*");
		expect(h.tags).toEqual(["vision"]);
	});
});

describe("rejections", () => {
	test("no verb", () => {
		const r = parseHint("maybe cloud i guess");
		expect(r.ok).toBe(false);
		if (!r.ok)
			expect(r.why).toBe(
				"hint must start with 'prefer' or 'must', got 'maybe'",
			);
	});
	test(">12 tokens", () => {
		expect(
			parseHint("prefer t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 t11 t12 t13").ok,
		).toBe(false);
	});
	test(">64-char token", () => {
		expect(parseHint(`prefer ${"x".repeat(65)}`).ok).toBe(false);
	});
	test("duplicate location", () => {
		const r = parseHint("prefer local cloud");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.why).toBe("hint: duplicate location ('cloud')");
	});
	test("duplicate model:", () => {
		expect(parseHint("prefer model:a model:b").ok).toBe(false);
	});
	test("empty host:/model:", () => {
		expect(parseHint("prefer host:").ok).toBe(false);
		expect(parseHint("prefer model:").ok).toBe(false);
	});
});

describe("header seam", () => {
	test("absent or empty = no hint", () => {
		expect(hintFromHeaders(new Headers())).toEqual({
			ok: true,
			raw: "",
			hint: null,
		});
		const h = new Headers({ "x-belt-hint": "   " });
		expect(hintFromHeaders(h).ok).toBe(true);
	});
	test("512-char cap", () => {
		const raw = `prefer ${"x".repeat(520)}`;
		const r = hintFromHeaders(new Headers({ "x-belt-hint": raw }));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.why).toContain("512");
	});
	test("duplicate header signature refused", () => {
		const h = new Headers([
			["x-belt-hint", "prefer local"],
			["x-belt-hint", "must cloud"],
		]);
		const r = hintFromHeaders(h);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.why).toBe("exactly one x-belt-hint header allowed");
	});
	test("good header parses", () => {
		const r = hintFromHeaders(
			new Headers({ "x-belt-hint": "must local reasoning" }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.hint?.verb).toBe("must");
	});
});

describe("fit", () => {
	const C = {
		kind: "local",
		machine: "box",
		model: "mlx-community/Qwen3.5-35B-A3B-4bit",
		tags: "reasoning multi-step reasoning Qwen3.5",
	};
	test("groups AND, tags OR, absent groups never count", () => {
		expect(hintFit(C, OK("prefer local reasoning"))).toBe(2);
		expect(hintFit(C, OK("prefer local qwen*"))).toBe(2);
		expect(hintFit(C, OK("prefer local vision"))).toBe(1);
		expect(hintFit(C, OK("prefer"))).toBe(0);
		expect(hintTotal(OK("prefer local reasoning"))).toBe(2);
	});
	test("non-compiling tag degrades to literal substring", () => {
		expect(hintFit(C, OK("prefer (("))).toBe(0);
		expect(hintFit(C, OK("prefer reasoning"))).toBe(1);
	});
});
