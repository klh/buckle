// test/expand.test.ts — W4 intent expansion: the W288 retarget law (local
// direct tier, never cloud, never the ladder), the opt-in default-OFF
// policy gate, honest metered skips, the REAL serving model recorded on
// events and in the rollup's model_group, and the pipeline OUT (the
// expanded body is what rides toward the upstream).
import { describe, expect, test } from "bun:test";
import {
	Expander,
	capBytes,
	contextOf,
	directCall,
	expansionBody,
	goalFromMessages,
	injectDigest,
	pickLocalDirect,
	EXPAND_SYSTEM,
} from "../src/expand.ts";
import { AidsLedger, parseAids } from "../src/aids.ts";
import { aidsRoutes, applyWireAids } from "../src/aids-routes.ts";
import type { AidsDeps } from "../src/aids-routes.ts";
import type { CandidateRow } from "../src/candidates.ts";
import type { AidsPolicy } from "../src/policy.ts";
import { servicemon } from "../src/servicemon.ts";
import { Preseeder } from "../src/preseed.ts";
import type { UpstreamPool } from "../src/upstreams.ts";
import { startMockUpstream } from "./mock.ts";
import { testDeps } from "./deps.ts";
import { createApp } from "../src/handlers.ts";

const mkRow = (over: Partial<CandidateRow>): CandidateRow => ({
	candidate_id: "127.0.0.1:8902:local-swarm",
	kind: "local",
	host: "127.0.0.1",
	port: 8902,
	model: "local-swarm",
	dialect: "openai",
	group: "local-swarm",
	capability_text: "",
	dep: {
		url: "http://127.0.0.1:8902",
		dialect: "openai",
		group: "local-swarm",
	},
	healthy: true,
	estimate_ms: null,
	calls: 0,
	errors: 0,
	load: 0,
	last_used: null,
	...over,
});

const POLICY_ON: AidsPolicy = { expand: { default: "on" } };
const POLICY_OFF: AidsPolicy = { expand: { default: "off" } };
const GOOD_CALL = async () => "• wants: modular seams\n• laws: pass-through";

type CallFn = (
	row: CandidateRow,
	body: Record<string, unknown>,
	timeoutMs: number,
) => Promise<string>;

const CANDIDATES: CandidateRow[] = [
	mkRow({
		candidate_id: "127.0.0.1:8902:local-swarm",
		estimate_ms: 90,
		calls: 3,
	}),
	mkRow({
		candidate_id: "127.0.0.1:8906:local-swarm",
		port: 8906,
		dep: {
			url: "http://127.0.0.1:8906",
			dialect: "openai",
			group: "local-swarm",
		},
	}),
];

const mkExpander = (policy: AidsPolicy, call?: CallFn) =>
	new Expander({
		policy,
		pick: (g) => pickLocalDirect(CANDIDATES, g),
		call: call ?? GOOD_CALL,
	});

describe("stanza + extraction", () => {
	test("expand parses; off still wins the stanza", () => {
		const s = parseAids("expand cache-align");
		expect(s.expand).toBe(true);
		const off = parseAids("off expand");
		expect(off.off).toBe(true);
		expect(off.expand).toBe(true);
	});

	test("goal = last user message (string, blocks, empty-trailing walk-back)", () => {
		expect(
			goalFromMessages([{ role: "user", content: "build the thing" }], 4000),
		).toBe("build the thing");
		expect(
			goalFromMessages(
				[
					{ role: "user", content: "first" },
					{
						role: "user",
						content: [{ type: "text", text: "second" }, { type: "image" }],
					},
				],
				4000,
			),
		).toBe("second");
		expect(
			goalFromMessages(
				[
					{ role: "user", content: "" },
					{ role: "user", content: "real" },
				],
				4000,
			),
		).toBe("real");
		expect(goalFromMessages([], 4000)).toBe("");
		expect(goalFromMessages(null, 4000)).toBe("");
	});
});

describe("extraction helpers", () => {
	test("goal capped at maxGoalChars", () => {
		expect(
			goalFromMessages([{ role: "user", content: "x".repeat(50) }], 10),
		).toBe("x".repeat(10));
	});

	test("contextOf: anthropic system string/array + openai system message", () => {
		expect(contextOf({ system: "laws" })).toBe("laws");
		expect(
			contextOf({
				system: [
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
				],
			}),
		).toBe("a\n\nb");
		expect(
			contextOf({ messages: [{ role: "system", content: "openai sys" }] }),
		).toBe("openai sys");
	});

	test("capBytes ascii + multibyte", () => {
		expect(capBytes("abcdef", 3)).toBe("abc");
		expect(capBytes("åååå", 4)).toBe("åå");
	});
});

describe("expansionBody + injection", () => {
	test("expansionBody deterministic: temp 0, non-stream, EXPAND_SYSTEM rides", () => {
		const b = expansionBody("goal", "ctx", "local-swarm");
		expect(b.model).toBe("local-swarm");
		expect(b.stream).toBe(false);
		expect(b.temperature).toBe(0);
		const msgs = b.messages as Array<Record<string, unknown>>;
		expect(msgs[0]?.content).toBe(EXPAND_SYSTEM);
		expect(msgs[1]?.content).toContain("goal");
		expect(msgs[1]?.content).toContain("[fleet context — laws + conventions]");
	});
});

describe("injectDigest", () => {
	test("both dialects", () => {
		const o = { messages: [{ role: "user", content: "u" }] };
		injectDigest(o, "openai", "d1");
		expect((o.messages as never[])[0]).toEqual({
			role: "system",
			content: expect.stringContaining("d1"),
		});
		const a = { system: "sys" };
		injectDigest(a, "anthropic", "d2");
		expect(String(a.system)).toContain("d2");
		const none = {};
		injectDigest(none, "anthropic", "d3");
		expect(String(none.system)).toContain("d3");
	});
});

describe("pickLocalDirect — the W288 retarget law", () => {
	test("picks the proven-fastest healthy local; unproven sorts back", () => {
		const pick = pickLocalDirect(CANDIDATES, "local-swarm");
		expect(pick?.candidate_id).toBe("127.0.0.1:8902:local-swarm");
	});

	test("never a cloud row — structural, whatever prefs say", () => {
		const cloud = mkRow({
			candidate_id: "10.0.0.9:443:remote",
			kind: "cloud",
			host: "10.0.0.9",
			port: 443,
			model: "remote",
			group: "remote",
			dep: { url: "https://10.0.0.9", dialect: "openai", group: "remote" },
		});
		expect(pickLocalDirect([cloud], "local-swarm")).toBeNull();
		expect(pickLocalDirect([cloud], "remote")).toBeNull();
	});

	test("unhealthy or wrong-group locals are skipped", () => {
		const sick = mkRow({ healthy: false });
		expect(pickLocalDirect([sick], "local-swarm")).toBeNull();
		expect(pickLocalDirect(CANDIDATES, "no-such-group")).toBeNull();
	});
});

describe("Expander decisions", () => {
	test("policy gate: default-off → skip(policy), call never made", async () => {
		let called = 0;
		const ex = mkExpander(POLICY_OFF, async () => {
			called++;
			return "x";
		});
		const out = await ex.expand({ goal: "g" });
		expect(out).toEqual({ decision: "skipped", skip_reason: "policy" });
		expect(called).toBe(0);
	});

	test("empty goal → invalid; no local → no-local", async () => {
		const ex = mkExpander(POLICY_ON);
		expect(await ex.expand({ goal: "  " })).toEqual({
			decision: "skipped",
			skip_reason: "invalid",
		});
		const none = new Expander({
			policy: POLICY_ON,
			pick: () => null,
			call: GOOD_CALL,
		});
		expect(await none.expand({ goal: "g" })).toEqual({
			decision: "skipped",
			skip_reason: "no-local",
		});
	});
});

describe("Expander outcomes", () => {
	test("call throws → outage", async () => {
		const ex = mkExpander(POLICY_ON, async () => {
			throw new Error("down");
		});
		expect(await ex.expand({ goal: "g" })).toEqual({
			decision: "skipped",
			skip_reason: "outage",
		});
	});

	test("success carries the REAL serving model + digest bytes", async () => {
		const ok = await mkExpander(POLICY_ON).expand({
			goal: "g",
			context: "laws",
		});
		expect(ok.decision).toBe("injected");
		expect(ok.served_model).toBe("local-swarm");
		expect(ok.bytes).toBeGreaterThan(0);
	});

	test("digest capped at max_digest_bytes", async () => {
		const big = "y".repeat(4000);
		const ex = mkExpander(POLICY_ON, async () => big);
		const out = await ex.expand({ goal: "g" });
		expect(out.decision).toBe("injected");
		expect(out.bytes).toBeLessThanOrEqual(2048);
	});
});

describe("served_model ledger law", () => {
	test("event carries it; rollup model_group is the real model, else 'all'", () => {
		const l = new AidsLedger(":memory:");
		l.record({
			ts: Date.now(),
			aid: "expand",
			decision: "injected",
			served_model: "mlx-community/Qwen3.5",
			tokens_injected: 12,
		});
		l.record({
			ts: Date.now(),
			aid: "preseed",
			decision: "injected",
			tokens_injected: 5,
		});
		l.rollup(24);
		const rows = l.rollupRows(24) as Array<Record<string, unknown>>;
		const expand = rows.find((r) => r.aid === "expand");
		const preseed = rows.find((r) => r.aid === "preseed");
		expect(expand?.model_group).toBe("mlx-community/Qwen3.5");
		expect(preseed?.model_group).toBe("all");
		const ev = l.eventsSince(0).find((e) => e.aid === "expand") as Record<
			string,
			unknown
		>;
		expect(ev.served_model).toBe("mlx-community/Qwen3.5");
	});
});

const mkDeps = (policy: AidsPolicy, expander?: Expander): AidsDeps => ({
	aids: new AidsLedger(":memory:"),
	preseeder: new Preseeder({ policy }),
	aidsPolicy: policy,
	sm: servicemon({ service: "t", port: 0 }),
	...(expander ? { expander } : {}),
});

describe("wire path (pipeline OUT)", () => {
	test("expand declared + policy on → digest injected, real model metered", async () => {
		const deps = mkDeps(POLICY_ON, mkExpander(POLICY_ON));
		const body = {
			model: "m",
			messages: [{ role: "user", content: "add the retry ladder" }],
		};
		const out = await applyWireAids(deps, "expand", body, "openai");
		expect(out.aligned).toBe(false);
		const msgs = body.messages as Array<Record<string, unknown>>;
		expect(msgs[0]?.role).toBe("system");
		expect(String(msgs[0]?.content)).toContain("modular seams");
		expect(String(msgs[0]?.content)).toContain("architectural-wants digest");
		const ev = deps.aids.eventsSince(0)[0] as Record<string, unknown>;
		expect(ev.aid).toBe("expand");
		expect(ev.decision).toBe("injected");
		expect(ev.served_model).toBe("local-swarm");
	});
});

describe("wire path", () => {
	test("policy off → body untouched, honest policy skip", async () => {
		const deps = mkDeps(POLICY_OFF, mkExpander(POLICY_OFF));
		const body = {
			model: "m",
			messages: [{ role: "user", content: "add the retry ladder" }],
		};
		await applyWireAids(deps, "expand", body, "openai");
		const msgs = body.messages as never[];
		expect(msgs.length).toBe(1);
		const ev = deps.aids.eventsSince(0)[0] as Record<string, unknown>;
		expect(ev.decision).toBe("skipped");
		expect(ev.skip_reason).toBe("policy");
	});

	test("anthropic: digest prepends to the system field", async () => {
		const deps = mkDeps(POLICY_ON, mkExpander(POLICY_ON));
		const body = {
			model: "m",
			system: "brief preamble",
			messages: [{ role: "user", content: "goal" }],
		};
		await applyWireAids(deps, "expand cache-align", body, "anthropic");
		expect(JSON.stringify(body.system)).toContain("digest");
	});
});

describe("/aids/expand route", () => {
	const route = (deps: AidsDeps, body: unknown): Promise<Response | null> =>
		aidsRoutes(
			deps,
			new Request("http://x/aids/expand", {
				method: "POST",
				body: JSON.stringify(body),
			}),
			"/aids/expand",
		);

	test("injected: digest + real serving model in the response", async () => {
		const deps = mkDeps(POLICY_ON, mkExpander(POLICY_ON));
		const res = await route(deps, { goal: "g", sid: "s1", work_item: "W4" });
		expect(res?.status).toBe(200);
		const json = (await res?.json()) as Record<string, unknown>;
		expect(json.ok).toBe(true);
		expect(json.decision).toBe("injected");
		expect(json.served_model).toBe("local-swarm");
		expect(json.digest).toContain("modular seams");
	});
});

describe("/aids/expand route rejections", () => {
	const route = (deps: AidsDeps, body: unknown): Promise<Response | null> =>
		aidsRoutes(
			deps,
			new Request("http://x/aids/expand", {
				method: "POST",
				body: JSON.stringify(body),
			}),
			"/aids/expand",
		);

	test("400 on missing goal; no-expander falls through (404 honest)", async () => {
		const deps = mkDeps(POLICY_ON, mkExpander(POLICY_ON));
		const bad = await route(deps, { context: "x" });
		expect(bad?.status).toBe(400);
		const noEx = mkDeps(POLICY_ON);
		expect(
			await aidsRoutes(
				noEx,
				new Request("http://x/aids/expand", { method: "POST", body: "{}" }),
				"/aids/expand",
			),
		).toBeNull();
	});

	test("policy off → 200 skipped(policy), metered", async () => {
		const deps = mkDeps(POLICY_OFF, mkExpander(POLICY_OFF));
		const res = await route(deps, { goal: "g" });
		const json = (await res?.json()) as Record<string, unknown>;
		expect(json.decision).toBe("skipped");
		expect(json.skip_reason).toBe("policy");
		expect(deps.aids.status().n).toBe(1);
	});
});

describe("directCall — real wire against a local mock", () => {
	test("happy path + non-200 → throw + timeout → throw", async () => {
		const mock = await startMockUpstream(
			() =>
				Response.json({
					choices: [
						{ message: { content: "• wants: seams\n• laws: pass-through" } },
					],
				}),
			{},
		);
		const slow = await startMockUpstream(async () => {
			await Bun.sleep(400);
			return Response.json({ choices: [{ message: { content: "late" } }] });
		}, {});
		const row = mkRow({
			dep: { url: mock.url, dialect: "openai", group: "local-swarm" },
		});
		const text = await directCall(
			row,
			expansionBody("g", "", "local-swarm"),
			2000,
		);
		expect(text).toContain("seams");
		const slowRow = mkRow({
			dep: { url: slow.url, dialect: "openai", group: "local-swarm" },
		});
		await expect(
			directCall(slowRow, expansionBody("g", "", "m"), 60),
		).rejects.toThrow();
		mock.close();
		slow.close();
	});
});

describe("e2e: pipeline OUT through createApp", () => {
	test("proxied request rides the expanded prompt; expansion hit the local tier", async () => {
		const mock = await startMockUpstream((_req, body) => {
			const b = body as Record<string, unknown>;
			const msgs = b.messages as Array<Record<string, unknown>>;
			const isExpand = msgs.some((m) =>
				String(m?.content ?? "").includes("expand a coding agent"),
			);
			if (isExpand) {
				return Response.json({
					choices: [{ message: { content: "• wants: modular seams" } }],
				});
			}
			return Response.json({
				choices: [{ message: { content: "ok completion" } }],
				usage: { prompt_tokens: 10, completion_tokens: 2 },
			});
		});
		const pool: UpstreamPool = {
			groups: () => ["m"],
			deployments: () => [{ url: mock.url, dialect: "openai", group: "m" }],
		};
		const deps = testDeps(pool, {
			policy: {
				num_retries: 1,
				allowed_fails: 3,
				cooldown_time: 30,
				aids: POLICY_ON,
			},
		});
		deps.expander = new Expander({
			policy: POLICY_ON,
			pick: () =>
				mkRow({
					dep: { url: mock.url, dialect: "openai", group: "local-swarm" },
				}),
			call: directCall,
		});
		const app = createApp(deps);
		const res = await app.fetch(
			new Request("http://x/v1/chat/completions", {
				method: "POST",
				headers: { "x-belt-aids": "expand" },
				body: JSON.stringify({
					model: "m",
					messages: [{ role: "user", content: "add the retry ladder" }],
				}),
			}),
		);
		expect(res.status).toBe(200);
		await res.json();
		const expandCall = mock.calls.find((c) =>
			JSON.stringify(c.body).includes("expand a coding agent"),
		);
		expect(expandCall).toBeDefined();
		const proxied = mock.calls.at(-1);
		const msgs = proxied?.body?.messages as Array<Record<string, unknown>>;
		expect(msgs[0]?.role).toBe("system");
		expect(String(msgs[0]?.content)).toContain("modular seams");
		mock.close();
	});
});
