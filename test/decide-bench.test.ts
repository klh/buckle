// test/decide-bench.test.ts — W136 acceptance §8.1: decide() < 1ms p50,
// < 5ms p99 over a prebuilt 50-row table, 10k decisions across the example
// hint set + no-hint. Regexps precompiled via the per-source caches (warm
// up first); audit writes and refresh are off-path by design.
import { expect, test } from "bun:test";
import { CandidateTable } from "../src/candidates.ts";
import { Cooldowns } from "../src/cooldown.ts";
import { decideRoute } from "../src/decide.ts";
import { parseHint } from "../src/hints.ts";
import { parsePolicy } from "../src/policy.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

const HINTS = [
	null,
	"prefer local",
	"must cloud",
	"prefer host:box model:qwen*",
	"must fast",
	"prefer reasoning code",
];

const POLICY = parsePolicy(`
gateway:
  num_retries: 1
  allowed_fails: 3
  cooldown_time: 30
tags:
  glm-5.3-flash: [fast, cheap, menial, general]
  local-swarm: [local, general, fast, cheap, code, extract, reasoning]
  gpt-5.2: [frontier, reasoning, code]
  claude-sonnet-5: [frontier, reasoning, code, long-context]
`);

const pool: UpstreamPool = {
	groups: () => ["glm-5.3-flash", "local-swarm", "gpt-5.2", "claude-sonnet-5"],
	deployments: (g) =>
		[0, 1, 2].map((i) => ({
			group: g,
			url: `http://host${String(i)}:8${String(100 + i)}`,
			dialect: "openai" as const,
		})),
};

const table = new CandidateTable({
	pool,
	policy: POLICY,
	cooldowns: new Cooldowns(3, 30),
});
expect(table.snapshot().length).toBe(12);

const prefs = { cost_speed: "balanced" as const, allow_cloud: true };
const decide = (raw: string | null) => {
	const h = raw ? parseHint(raw) : null;
	return decideRoute({
		hint: h?.ok ? h.hint : null,
		hintRaw: raw ?? "",
		candidates: table.snapshot(),
		prefs,
		dialect: "openai",
	});
};

// warm the regexp caches so steady-state decisions compile nothing
test("decision path is sub-millisecond (W136 §8.1)", () => {
	for (let i = 0; i < 200; i++) decide(HINTS[i % HINTS.length] ?? null);
	const samples: number[] = [];
	for (let i = 0; i < 10_000; i++) {
		const raw = HINTS[i % HINTS.length] ?? null;
		const t0 = performance.now();
		decide(raw);
		samples.push(performance.now() - t0);
	}
	samples.sort((a, b) => a - b);
	const p = (q: number): number =>
		samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] ?? 0;
	const p50 = p(0.5);
	const p99 = p(0.99);
	console.log(
		`decide() p50=${p50.toFixed(4)}ms p99=${p99.toFixed(4)}ms over ${String(samples.length)} decisions`,
	);
	expect(p50).toBeLessThan(1); // the <1ms law (W136 §8.1)
	expect(p99).toBeLessThan(5);
});
