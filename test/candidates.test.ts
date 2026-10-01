// test/candidates.test.ts — the candidate table: structural flashx absence,
// own-outcome health (cooldown feeds it), EWMA from outcomes, cloud kinds,
// background refresh.
import { describe, expect, test } from "bun:test";
import { CandidateTable } from "../src/candidates.ts";
import { Cooldowns } from "../src/cooldown.ts";
import { parsePolicy } from "../src/policy.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

const POLICY = parsePolicy(`
gateway:
  num_retries: 1
  allowed_fails: 3
  cooldown_time: 30
tags:
  glm-5.3-flash: [fast, cheap, general]
  local-swarm: [local, code, reasoning]
`);

const poolOf = (entries: Array<[string, string[]]>): UpstreamPool => {
	const map = new Map(entries);
	return {
		groups: () => [...map.keys()],
		deployments: (g) =>
			(map.get(g) ?? []).map((url) => ({
				group: g,
				url,
				dialect: "openai" as const,
			})),
	};
};

describe("candidate table", () => {
	const cd = new Cooldowns(3, 30);
	const t = (entries: Array<[string, string[]]>): CandidateTable =>
		new CandidateTable({
			pool: poolOf(entries),
			policy: POLICY,
			cooldowns: cd,
		});

	test("rows per group-deployment with tags capability text", () => {
		const rows = t([["glm-5.3-flash", ["http://127.0.0.1:8902"]]]).snapshot();
		expect(rows.length).toBe(1);
		const r = rows[0];
		if (!r) return;
		expect(r.candidate_id).toBe("127.0.0.1:8902:glm-5.3-flash");
		expect(r.kind).toBe("local");
		expect(r.capability_text).toContain("fast");
		expect(r.capability_text).toContain("glm-5.3-flash");
		expect(r.healthy).toBe(true);
	});

	test("NEVER flashx: absent from the table structurally", () => {
		const rows = t([
			["glm-5.3-flash", ["http://127.0.0.1:8902"]],
			["glm-5.3-flashx", ["http://127.0.0.1:8907"]],
		]).snapshot();
		expect(rows.every((r) => !r.candidate_id.includes("flashx"))).toBe(true);
	});

	test("cloud kind + cloudGroups from non-loopback urls", () => {
		const rows = t([
			["gpt-5.2", ["https://relay.example/v1"]],
			["local-swarm", ["http://127.0.0.1:8903"]],
		]).snapshot();
		const cloud = rows.find((r) => r.group === "gpt-5.2");
		expect(cloud?.kind).toBe("cloud");
		expect(
			t([
				["gpt-5.2", ["https://relay.example/v1"]],
				["local-swarm", ["http://127.0.0.1:8903"]],
			])
				.cloudGroups()
				.has("gpt-5.2"),
		).toBe(true);
	});

	test("own-outcome health: allowed_fails bench → unhealthy → recovery", () => {
		const fresh = new Cooldowns(3, 30);
		const table = new CandidateTable({
			pool: poolOf([["glm-5.3-flash", ["http://127.0.0.1:8902"]]]),
			policy: POLICY,
			cooldowns: fresh,
		});
		const dep = {
			group: "glm-5.3-flash",
			url: "http://127.0.0.1:8902",
			dialect: "openai" as const,
		};
		fresh.failure(dep);
		fresh.failure(dep);
		table.rebuild();
		expect(table.snapshot()[0]?.healthy).toBe(true); // 2 < allowed_fails
		fresh.failure(dep); // 3rd consecutive → benched
		table.rebuild();
		expect(table.snapshot()[0]?.healthy).toBe(false);
	});

	test("EWMA from own outcomes (α=0.3)", () => {
		const table = t([["glm-5.3-flash", ["http://127.0.0.1:8902"]]]);
		const id = table.snapshot()[0]?.candidate_id ?? "";
		table.recordOutcome(id, 100, true);
		table.recordOutcome(id, 200, true);
		const r = table.snapshot()[0];
		expect(r?.estimate_ms).toBe(130); // round(0.7*100 + 0.3*200)
		expect(r?.calls).toBe(2);
		expect(r?.errors).toBe(0);
		table.recordOutcome(id, 10, false);
		const r2 = table.snapshot()[0];
		expect(r2?.errors).toBe(1);
		expect(r2?.estimate_ms).toBe(94); // round(0.7*130 + 0.3*10)
	});
});
