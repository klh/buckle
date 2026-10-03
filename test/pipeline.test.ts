// test/pipeline.test.ts — W5 prompt pipeline IN: the politeness-only
// inbound ruleset (meaning qualifiers survive verbatim, code never
// touched), the rid-keyed sidestore (raw one GET away), the metered wire
// seam (byte identity on declared requests), and the routes.
import { describe, expect, test } from "bun:test";
import {
	CondenseStore,
	condenseText,
	extractText,
	pipelineRoutes,
} from "../src/pipeline.ts";
import { condenseInbound } from "../src/pipeline-wire.ts";
import { AidsLedger } from "../src/aids.ts";
import { servicemon } from "../src/servicemon.ts";
import { startMockUpstream } from "./mock.ts";
import { testDeps } from "./deps.ts";
import { createApp, type AppDeps } from "../src/handlers.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

const POOL = (url: string): UpstreamPool => ({
	groups: () => ["glm-5-3-flash"],
	deployments: (g) => [{ group: g, url, dialect: "openai" as const }],
});

const DEPS = (url: string, policy?: AppDeps["aidsPolicy"]): AppDeps => ({
	...testDeps(POOL(url)),
	aidsPolicy: policy ?? {},
	pipeline: new CondenseStore(":memory:"),
});

describe("condenseText ruleset", () => {
	test("courtesy sentences drop; payload survives verbatim", () => {
		const r = condenseText(
			"Ran the suite: 205 pass.\nLet me know if you have questions.\nHope this helps!",
		);
		expect(r.rules.length).toBeGreaterThanOrEqual(2);
		expect(r.text).toBe("Ran the suite: 205 pass.");
	});

	test("prefix strips keep payload verbatim", () => {
		const r = condenseText(
			"Please note that the 429 walk needs retry-after honored.",
		);
		expect(r.text).toBe("the 429 walk needs retry-after honored.");
	});

	test("meaning qualifiers inside sentences survive verbatim", () => {
		const r = condenseText(
			"Fixed the gate but just for the 429 case; only touch the users table.",
		);
		expect(r.text).toBe(
			"Fixed the gate but just for the 429 case; only touch the users table.",
		);
		expect(r.rules).toEqual([]);
	});

	test("code fences are never touched; courtesy closer still drops", () => {
		const body = [
			"Please note the diff below.",
			"",
			"```bash",
			"Please note that this line is code and must not move.",
			"```",
			"",
			"Hope this helps!",
		].join("\n");
		const r = condenseText(body);
		expect(r.text).toContain(
			"Please note that this line is code and must not move.",
		);
		expect(r.text).toContain("the diff below.");
		expect(r.text).not.toContain("Hope this helps!");
	});

	test("inline code span content survives a prefix strip", () => {
		const r = condenseText("Please note that `bun test --only src/x.ts`.");
		expect(r.text).toBe("`bun test --only src/x.ts`.");
	});

	test("idempotent: a second pass adds no rules, changes no bytes", () => {
		const once = condenseText(
			"Thanks!\nPlease note that deploy needs a green bench.",
		);
		const twice = condenseText(once.text);
		expect(twice.rules).toEqual([]);
		expect(twice.text).toBe(once.text);
	});
});

describe("extractText", () => {
	test("anthropic text blocks join; openai message.content string", () => {
		const a = extractText("anthropic", {
			content: [
				{ type: "text", text: "one" },
				{ type: "tool_use", id: "t" },
				{ type: "text", text: "two" },
			],
		});
		expect(a).toBe("one\ntwo");
		const o = extractText("openai", {
			choices: [{ message: { content: "heya" } }],
		});
		expect(o).toBe("heya");
	});

	test("no honest extraction → null (metered skip upstream)", () => {
		expect(extractText("anthropic", { content: [] })).toBeNull();
		expect(extractText("openai", { choices: [] })).toBeNull();
		expect(extractText("openai", "not an object")).toBeNull();
	});
});

describe("CondenseStore", () => {
	test("put/get roundtrip + honest miss", () => {
		const s = new CondenseStore(":memory:");
		s.put({
			rid: "r1",
			dialect: "openai",
			condensed: "short",
			raw: "short\nThanks!",
			rules: ["drop:x"],
		});
		const g = s.get("r1");
		expect(g?.condensed).toBe("short");
		expect(g?.raw).toContain("Thanks!");
		expect(g?.rules).toEqual(["drop:x"]);
		expect(s.get("missing")).toBeNull();
		s.close();
	});

	test("bounded: the 501st row evicts the oldest", () => {
		const s = new CondenseStore(":memory:");
		for (let i = 1; i <= 501; i++) {
			s.put({
				rid: `r${i}`,
				dialect: "openai",
				condensed: "c",
				raw: "r",
				rules: [],
			});
		}
		expect(s.get("r1")).toBeNull();
		expect(s.get("r2")).not.toBeNull();
		expect(s.get("r501")).not.toBeNull();
		s.close();
	});
});

describe("condenseInbound metering", () => {
	const mkDeps = (policy?: AppDeps["aidsPolicy"]) => ({
		pipeline: new CondenseStore(":memory:"),
		aidsPolicy: policy ?? {},
		aids: new AidsLedger(":memory:"),
		sm: servicemon({ service: "t", port: 0 }),
	});
	const ctxOf = (declared: boolean) => ({
		rid: "rtest",
		dialect: "openai" as const,
		condenseIn: declared,
	});
	const TEXTY = {
		choices: [{ message: { content: "Ran it.\nThanks!" } }],
	};

	test("declared + gainful → stored row + injected aid event", () => {
		const d = mkDeps();
		condenseInbound(d, ctxOf(true), TEXTY);
		expect(d.pipeline.get("rtest")?.raw).toContain("Thanks!");
		const row = d.aids.eventsSince(0)[0] as Record<string, unknown>;
		expect(row.aid).toBe("condense-in");
		expect(row.decision).toBe("injected");
	});

	test("undeclared → zero touch, no aid event", () => {
		const d = mkDeps();
		condenseInbound(d, ctxOf(false), TEXTY);
		expect(d.pipeline.get("rtest")).toBeNull();
		expect(d.aids.status().n ?? 0).toBe(0);
	});

	test("policy off → skipped(policy), nothing stored", () => {
		const d = mkDeps({ "condense-in": { default: "off" } });
		condenseInbound(d, ctxOf(true), TEXTY);
		expect(d.pipeline.get("rtest")).toBeNull();
		const row = d.aids.eventsSince(0)[0] as Record<string, unknown>;
		expect(row.decision).toBe("skipped");
		expect(row.skip_reason).toBe("policy");
	});

	test("no honest text → skipped(no_text); huge text → too_large", () => {
		const d = mkDeps();
		condenseInbound(d, ctxOf(true), { choices: [] });
		const r1 = d.aids.eventsSince(0)[0] as Record<string, unknown>;
		expect(r1.skip_reason).toBe("no_text");
		const big = mkDeps({ "condense-in": { max_bytes: 4 } });
		condenseInbound(big, ctxOf(true), TEXTY);
		const r2 = big.aids.eventsSince(0)[0] as Record<string, unknown>;
		expect(r2.skip_reason).toBe("too_large");
	});

	test("no rules fired → skipped(no_gain), nothing stored", () => {
		const d = mkDeps();
		condenseInbound(d, ctxOf(true), {
			choices: [{ message: { content: "just the facts" } }],
		});
		expect(d.pipeline.get("rtest")).toBeNull();
		const row = d.aids.eventsSince(0)[0] as Record<string, unknown>;
		expect(row.skip_reason).toBe("no_gain");
	});
});

describe("pipeline routes", () => {
	const seeded = (): CondenseStore => {
		const s = new CondenseStore(":memory:");
		s.put({
			rid: "rX",
			dialect: "openai",
			condensed: "the short story",
			raw: "the short story\nThanks!",
			rules: ["drop:thx"],
		});
		return s;
	};

	test("rid GET returns condensed + raw", async () => {
		const deps = { pipeline: seeded() };
		const res = await pipelineRoutes(
			deps,
			new Request("http://x/pipeline/in/rX"),
			"/pipeline/in/rX",
		);
		expect(res?.status).toBe(200);
		const body = (await res?.json()) as { raw: string; condensed: string };
		expect(body.condensed).toBe("the short story");
		expect(body.raw).toContain("Thanks!");
	});

	test("list + honest 404s (miss + bare deps)", async () => {
		const deps = { pipeline: seeded() };
		const list = await pipelineRoutes(
			deps,
			new Request("http://x/pipeline/in"),
			"/pipeline/in",
		);
		const lb = (await list?.json()) as { rows: Array<{ rid: string }> };
		expect(lb.rows.map((r) => r.rid)).toEqual(["rX"]);
		const miss = await pipelineRoutes(
			deps,
			new Request("http://x/pipeline/in/zz"),
			"/pipeline/in/zz",
		);
		expect(miss?.status).toBe(404);
		const bare = await pipelineRoutes(
			{},
			new Request("http://x/pipeline/in/rX"),
			"/pipeline/in/rX",
		);
		expect(bare?.status).toBe(404);
	});
});

describe("wire e2e: condense-in through createApp", () => {
	test("declared request: served bytes identical, raw one GET away", async () => {
		const UPSTREAM_BODY = JSON.stringify({
			id: "1",
			choices: [
				{
					message: {
						content:
							"Landed the fix.\nPlease note that the bench needs a rerun.\nThanks!",
					},
				},
			],
			usage: { prompt_tokens: 9, completion_tokens: 12 },
		});
		const upstream = await startMockUpstream(
			() =>
				new Response(UPSTREAM_BODY, {
					headers: { "content-type": "application/json" },
				}),
		);
		const d = DEPS(upstream.url);
		const app = createApp(d);
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "x-belt-aids": "condense-in" },
				body: JSON.stringify({ model: "glm-5-3-flash", stream: false }),
			}),
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(UPSTREAM_BODY); // byte identity held
		const rid = res.headers.get("x-belt-rid") ?? "";
		expect(rid.length).toBeGreaterThan(0);
		const raw = await app.fetch(
			new Request(`${upstream.url}/pipeline/in/${rid}`),
		);
		expect(raw.status).toBe(200);
		const row = (await raw.json()) as {
			condensed: string;
			raw: string;
			rules: string[];
		};
		expect(row.raw).toContain("Thanks!");
		expect(row.condensed).not.toContain("Thanks!");
		expect(row.rules.length).toBeGreaterThan(0);
		upstream.close();
	});
});
