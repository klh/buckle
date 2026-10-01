// test/routing-laws.test.ts — the W136 laws end-to-end through createApp
// with real mock upstreams: header contract, must-error honesty, degraded
// visibility, the escalation gate, and the audit trail.
import { describe, expect, test } from "bun:test";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";
import { createApp, type AppDeps } from "../src/handlers.ts";
import { parsePolicy } from "../src/policy.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

const SIMPLE = "what is 2+2";

const POLICY = parsePolicy(`
gateway:
  num_retries: 1
  allowed_fails: 3
  cooldown_time: 30
  fallbacks:
    glm-5.3-flash: [gpt-5.2]
tags:
  glm-5.3-flash: [fast, cheap, general]
  gpt-5.2: [frontier, reasoning, code]
`);

function poolOf(entries: Array<[string, string[]]>): UpstreamPool {
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
}

function lawsDeps(
	entries: Array<[string, string[]]>,
	prefs?: {
		allow_cloud: boolean;
		cost_speed: "balanced" | "cost" | "speed" | "quality";
	},
): AppDeps {
	return testDeps(poolOf(entries), {
		policy: POLICY,
		prefs,
		sleepMs: async () => {}, // law tests measure decisions, not backoff
	});
}

const post = (
	app: { fetch(req: Request): Promise<Response> },
	url: string,
	body: Record<string, unknown>,
	hint?: string,
): Promise<Response> => {
	const headers: Record<string, string> = {};
	if (hint) headers["x-belt-hint"] = hint;
	return app.fetch(
		new Request(url, { method: "POST", headers, body: JSON.stringify(body) }),
	);
};

interface RouteHeader {
	rid: string;
	decision: string;
	latency_class?: string;
	tier?: string;
	target?: { kind: string; host: string; port: number; model: string };
}

describe("wire contract", () => {
	test("headers + audit on a plain proxied request", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({
				id: "1",
				usage: { prompt_tokens: 3, completion_tokens: 1 },
			}),
		);
		const deps = lawsDeps([["glm-5.3-flash", [upstream.url]]]);
		const app = createApp(deps);
		const res = await post(app, `${upstream.url}/v1/chat/completions`, {
			model: "glm-5.3-flash",
			messages: [{ role: "user", content: SIMPLE }],
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("x-belt-rid")).toBeTruthy();
		const route = JSON.parse(
			res.headers.get("x-belt-route") ?? "{}",
		) as RouteHeader;
		expect(route.decision).toBe("policy");
		expect(route.target?.kind).toBe("local");
		// the echo reports the delivered row after its own outcome landed —
		// the mock is quick, so the first call is already proven fast
		expect(route.latency_class).toBe("fast");
		expect(route.tier).toBe("SIMPLE");
		expect(res.headers.get("x-belt-error")).toBeNull();
		const rows = deps.ledger.auditRows();
		expect(rows.length).toBe(1);
		const r = rows[0] ?? {};
		expect(r.decision).toBe("policy");
		expect(r.status).toBe(200);
		expect(r.ok).toBe(1);
		expect(r.hint).toBe("");
		upstream.close();
	});
});

describe("must laws (§4.2, §7.5)", () => {
	test("must speed → honest 503 no_healthy_fit, nothing sent upstream", async () => {
		const upstream = await startMockUpstream(() => Response.json({ id: "1" }));
		const deps = lawsDeps([["glm-5.3-flash", [upstream.url]]]);
		const app = createApp(deps);
		const res = await post(
			app,
			`${upstream.url}/v1/messages`,
			{ model: "glm-5.3-flash", messages: [{ role: "user", content: SIMPLE }] },
			"must speed",
		);
		expect(res.status).toBe(503);
		expect(res.headers.get("x-belt-error")).toBe("no_healthy_fit");
		expect(upstream.calls.length).toBe(0); // nothing was sent upstream
		const row = deps.ledger.auditRows()[0] ?? {};
		expect(row.decision).toBe("errored");
		expect(row.error_code).toBe("no_healthy_fit");
		expect(row.status).toBe(503);
		upstream.close();
	});

	test("must cloud with prefs closed → cloud_forbidden", async () => {
		const upstream = await startMockUpstream(() => Response.json({ id: "1" }));
		const deps = lawsDeps([["glm-5.3-flash", [upstream.url]]], {
			allow_cloud: false,
			cost_speed: "balanced",
		});
		const app = createApp(deps);
		const res = await post(
			app,
			`${upstream.url}/v1/chat/completions`,
			{ model: "glm-5.3-flash" },
			"must cloud",
		);
		expect(res.status).toBe(503);
		expect(res.headers.get("x-belt-error")).toBe("cloud_forbidden");
		upstream.close();
	});
});

describe("prefer degrade + refusal (§4.1, §7.7)", () => {
	test("soft hint below full fit still serves, audit says degraded", async () => {
		const upstream = await startMockUpstream(() => Response.json({ id: "1" }));
		const deps = lawsDeps([["glm-5.3-flash", [upstream.url]]]);
		const app = createApp(deps);
		const res = await post(
			app,
			`${upstream.url}/v1/chat/completions`,
			{ model: "glm-5.3-flash" },
			"prefer reasoning",
		);
		expect(res.status).toBe(200); // served, not refused
		const route = JSON.parse(
			res.headers.get("x-belt-route") ?? "{}",
		) as RouteHeader;
		expect(route.decision).toBe("degraded");
		const row = deps.ledger.auditRows()[0] ?? {};
		expect(row.decision).toBe("degraded");
		expect(row.hint).toBe("prefer reasoning");
		upstream.close();
	});

	test("bad hint is refused, never guessed", async () => {
		const upstream = await startMockUpstream(() => Response.json({ id: "1" }));
		const deps = lawsDeps([["glm-5.3-flash", [upstream.url]]]);
		const app = createApp(deps);
		const res = await post(
			app,
			`${upstream.url}/v1/chat/completions`,
			{ model: "glm-5.3-flash" },
			"maybe cloud i guess",
		);
		expect(res.status).toBe(400);
		expect(res.headers.get("x-belt-error")).toBe("bad_hint");
		const row = deps.ledger.auditRows()[0] ?? {};
		expect(row.decision).toBe("denied");
		expect(row.error_code).toBe("bad_hint");
		upstream.close();
	});
});
