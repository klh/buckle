// test/decide.test.ts — W136 §4 semantics: must never substitutes, prefer
// degrades by policy, no-hint = proven-latency ordering, the W136 escalation
// gate, latency classes.
import { describe, expect, test } from "bun:test";
import type { CandidateRow } from "../src/candidates.ts";
import {
	compareCandidates,
	decideRoute,
	latencyClass,
	mayEscalate,
} from "../src/decide.ts";
import { parseHint } from "../src/hints.ts";
import type { Prefs } from "../src/policy.ts";

let seq = 0;
const row = (over: Partial<CandidateRow> = {}): CandidateRow => ({
	candidate_id: `h:${String(9000 + seq++)}:m`,
	kind: "local",
	host: "h",
	port: 9000 + seq,
	model: "m",
	dialect: "openai",
	group: "glm-5.3-flash",
	capability_text: "fast cheap glm-5.3-flash",
	dep: {
		group: "glm-5.3-flash",
		url: `http://h:${String(9000 + seq)}`,
		dialect: "openai",
	},
	healthy: true,
	estimate_ms: null,
	calls: 0,
	errors: 0,
	load: 0,
	last_used: null,
	...over,
});

const HINT = (raw: string | null) => {
	if (!raw) return null;
	const r = parseHint(raw);
	return r.ok ? r.hint : null;
};

const PREFS_OPEN: Prefs = { cost_speed: "balanced", allow_cloud: true };
const decide = (
	hintRaw: string | null,
	candidates: CandidateRow[],
	prefs: Prefs = PREFS_OPEN,
	dialect: "openai" | "anthropic" = "openai",
) =>
	decideRoute({
		hint: HINT(hintRaw),
		hintRaw: hintRaw ?? "",
		candidates,
		prefs,
		dialect,
	});

describe("must (law 2)", () => {
	test("full fit → policy, ordered by proven-latency", () => {
		const a = row({ estimate_ms: 900, calls: 5 });
		const b = row({ estimate_ms: 400, calls: 5 });
		const r = decide("must fast", [a, b]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.sel.decision).toBe("policy");
			expect(r.sel.head.candidate_id).toBe(b.candidate_id);
			expect(r.sel.fit).toBe(1);
		}
	});
	test("no healthy full fit → no_healthy_fit, never a substitute", () => {
		const r = decide("must speed", [row(), row({ healthy: false })]);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.err.code).toBe("no_healthy_fit");
			expect(r.err.why).toContain("must never substitutes");
		}
	});
	test("must cloud + gate closed → cloud_forbidden", () => {
		const cloud = row({ kind: "cloud", host: "cloud.example" });
		const r = decide("must cloud", [cloud], {
			cost_speed: "balanced",
			allow_cloud: false,
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.err.code).toBe("cloud_forbidden");
	});
	test("must local never selects cloud even when warranted", () => {
		const cloud = row({ kind: "cloud", capability_text: "frontier reasoning" });
		const local = row({ capability_text: "local general" });
		const r = decide("must local", [cloud, local]);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.sel.head.kind).toBe("local");
	});
});

describe("prefer (law 3)", () => {
	test("full fit wins; head below full fit degrades and says so", () => {
		const good = row({ capability_text: "fast general" });
		const better = row({ capability_text: "fast general reasoning" });
		const r = decide("prefer reasoning", [good, better]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.sel.head.candidate_id).toBe(better.candidate_id);
			expect(r.sel.decision).toBe("policy");
		}
		const r2 = decide("prefer reasoning", [good]);
		expect(r2.ok).toBe(true);
		if (r2.ok) {
			expect(r2.sel.decision).toBe("degraded");
			expect(r2.sel.fit).toBe(0);
		}
	});
	test("prefer cloud + gate closed → degraded local (never refused)", () => {
		const local = row({ capability_text: "local general" });
		const r = decide("prefer cloud", [local], {
			cost_speed: "balanced",
			allow_cloud: false,
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.sel.head.kind).toBe("local");
			expect(r.sel.decision).toBe("degraded");
		}
	});
});

describe("no hint (law 4)", () => {
	test("healthy → proven → effMs → errors → LRU (belt parity)", () => {
		const unproven = row({ calls: 0 });
		const provenSlow = row({ estimate_ms: 900, calls: 3 });
		const provenFast = row({ estimate_ms: 200, calls: 3 });
		const unhealthy = row({ healthy: false, estimate_ms: 1, calls: 3 });
		const r = decide(null, [unproven, provenSlow, unhealthy, provenFast]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const ids = r.sel.ordered.map((c) => c.candidate_id);
			expect(ids).toEqual([
				provenFast.candidate_id,
				provenSlow.candidate_id,
				unproven.candidate_id,
				unhealthy.candidate_id,
			]);
			expect(r.sel.decision).toBe("policy");
		}
	});
	test("load penalty bends effMs", () => {
		const loaded = row({ estimate_ms: 100, calls: 2, load: 10 });
		const calm = row({ estimate_ms: 150, calls: 2 });
		const r = decide(null, [loaded, calm]);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.sel.head.candidate_id).toBe(calm.candidate_id);
	});
});

describe("escalation gate (W136 §5.2)", () => {
	const cloud = new Set(["gpt-5.2"]);
	const base = {
		group: "gpt-5.2",
		tier: "COMPLEX",
		prefs: PREFS_OPEN,
		cloudGroups: cloud,
	};
	test("all conditions AND-ed", () => {
		expect(mayEscalate({ ...base, attempts: 2 })).toBe(true);
		expect(mayEscalate({ ...base, attempts: 1 })).toBe(false);
		expect(
			mayEscalate({
				...base,
				attempts: 2,
				prefs: { ...PREFS_OPEN, allow_cloud: false },
			}),
		).toBe(false);
		expect(
			mayEscalate({
				...base,
				attempts: 2,
				prefs: { ...PREFS_OPEN, cost_speed: "cost" },
			}),
		).toBe(false);
		expect(mayEscalate({ ...base, attempts: 2, tier: "SIMPLE" })).toBe(false);
		expect(mayEscalate({ ...base, attempts: 2, tier: "MEDIUM" })).toBe(false);
		expect(
			mayEscalate({
				...base,
				attempts: 2,
				tier: "SIMPLE",
				prefs: { ...PREFS_OPEN, cost_speed: "quality" },
			}),
		).toBe(true); // quality mode warrants regardless of tier
		expect(mayEscalate({ ...base, attempts: 2, group: "local-swarm" })).toBe(
			false,
		); // non-cloud rung is not an escalation
	});
});

describe("latency classes", () => {
	test("unproven | fast | medium | slow thresholds", () => {
		expect(latencyClass(null)).toBe("unproven");
		expect(latencyClass(138)).toBe("fast");
		expect(latencyClass(499)).toBe("fast");
		expect(latencyClass(500)).toBe("medium");
		expect(latencyClass(1999)).toBe("medium");
		expect(latencyClass(2000)).toBe("slow");
	});
	test("compareCandidates is the exported law-4 comparator", () => {
		const a = row({ estimate_ms: 100, calls: 2 });
		const b = row({ estimate_ms: 200, calls: 2 });
		expect(compareCandidates(a, b)).toBeLessThan(0);
		expect(compareCandidates(b, a)).toBeGreaterThan(0);
	});
});
