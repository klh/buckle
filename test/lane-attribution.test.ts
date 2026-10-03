// test/lane-attribution.test.ts — W1: /w/<slug> per-lane attribution: the
// prefix is stripped before the upstream, the slug lands in the audit row +
// x-belt-route header, bare paths stay unchanged, malformed slugs 404, and
// pre-lane databases survive the ALTER guard.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { laneEnv } from "../src/agents.ts";
import { lanePrefixOf } from "../src/citizenship.ts";
import { createApp } from "../src/handlers.ts";
import { Ledger } from "../src/ledger.ts";
import { startMockUpstream } from "./mock.ts";
import { testDeps } from "./deps.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

function deps(pool: UpstreamPool) {
	return testDeps(pool);
}

function poolOf(url: string): UpstreamPool {
	return {
		groups: () => ["glm-5.3-flash"],
		deployments: (g) => [{ group: g, url, dialect: "openai" as const }],
	};
}

const CHAT_BODY = JSON.stringify({ model: "glm-5.3-flash" });

describe("lane prefix routing", () => {
	test("prefixed ingress: prefix stripped, lane stamped", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "1", choices: [], usage: { prompt_tokens: 3 } }),
		);
		const d = deps(poolOf(upstream.url));
		const app = createApp(d);
		const res = await app.fetch(
			new Request(`${upstream.url}/w/autow1/v1/chat/completions`, {
				method: "POST",
				body: CHAT_BODY,
			}),
		);
		expect(res.status).toBe(200);
		expect(upstream.calls[0]?.path).toBe("/v1/chat/completions");
		const route = JSON.parse(res.headers.get("x-belt-route") ?? "{}") as {
			lane?: string;
		};
		expect(route.lane).toBe("autow1");
		const audit = d.ledger.auditRows()[0] as { lane?: string } | undefined;
		expect(audit?.lane).toBe("autow1");
		upstream.close();
	});

	test("prefixed /v1/messages keeps dialect anthropic", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "msg_1", usage: {} }),
		);
		const anthropicPool: UpstreamPool = {
			groups: () => ["glm-5.3-flash"],
			deployments: (g) => [
				{ group: g, url: upstream.url, dialect: "anthropic" as const },
			],
		};
		const d = deps(anthropicPool);
		const app = createApp(d);
		const res = await app.fetch(
			new Request(`${upstream.url}/w/lane-x/v1/messages`, {
				method: "POST",
				body: CHAT_BODY,
			}),
		);
		expect(res.status).toBe(200);
		expect(upstream.calls[0]?.path).toBe("/v1/messages");
		const audit = d.ledger.auditRows()[0] as
			| { lane?: string; dialect?: string }
			| undefined;
		expect(audit?.lane).toBe("lane-x");
		expect(audit?.dialect).toBe("anthropic");
		upstream.close();
	});

	test("bare paths record an empty lane", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "1", choices: [], usage: { prompt_tokens: 3 } }),
		);
		const d = deps(poolOf(upstream.url));
		const app = createApp(d);
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/chat/completions`, {
				method: "POST",
				body: CHAT_BODY,
			}),
		);
		expect(res.status).toBe(200);
		const audit = d.ledger.auditRows()[0] as { lane?: string } | undefined;
		expect(audit?.lane).toBe("");
		upstream.close();
	});

	test("malformed slugs + non-ingress paths under the prefix 404", async () => {
		const app = createApp(deps(poolOf("http://127.0.0.1:1")));
		for (const path of ["/w//v1/messages", "/w/autow1/federation"]) {
			const res = await app.fetch(
				new Request(`http://127.0.0.1:1${path}`, {
					method: "POST",
					body: CHAT_BODY,
				}),
			);
			expect(res.status).toBe(404);
		}
	});

	test("prefixed OPTIONS introspects the inner ingress path", async () => {
		const app = createApp(deps(poolOf("http://127.0.0.1:1")));
		const res = await app.fetch(
			new Request("http://127.0.0.1:1/w/autow1/v1/messages", {
				method: "OPTIONS",
			}),
		);
		expect(res.status).toBe(204);
		expect(res.headers.get("allow")).toBe("POST, OPTIONS");
	});
});

describe("lane prefix contract", () => {
	test("lanePrefixOf splits the slug or passes through", () => {
		expect(lanePrefixOf("/v1/messages")).toEqual({
			lane: "",
			path: "/v1/messages",
		});
		expect(lanePrefixOf("/w/autow1/v1/messages")).toEqual({
			lane: "autow1",
			path: "/v1/messages",
		});
		expect(lanePrefixOf("/w//v1/messages")).toEqual({
			lane: "",
			path: "/w//v1/messages",
		});
		expect(lanePrefixOf("/w/au tow/v1/messages").lane).toBe("");
	});

	test("laneEnv builds the base-URL union with dialect asymmetry", () => {
		const env = laneEnv("autow1", "http://127.0.0.1:4101/v1");
		expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4101/w/autow1");
		expect(env.OPENAI_BASE_URL).toBe("http://127.0.0.1:4101/w/autow1/v1");
		expect(env.OPENAI_API_BASE).toBe("http://127.0.0.1:4101/w/autow1/v1");
		expect(env.GOOGLE_GEMINI_BASE_URL).toBe("http://127.0.0.1:4101/w/autow1");
	});

	test("pre-lane databases: ALTER guard keeps audit writes alive", () => {
		const path = `/tmp/w1-lane-test-${Date.now()}.db`;
		const raw = new Database(path, { create: true });
		raw.exec(
			"CREATE TABLE route_audit (rid TEXT PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL DEFAULT '', dialect TEXT NOT NULL DEFAULT '', hint TEXT NOT NULL DEFAULT '', candidates_seen INTEGER NOT NULL DEFAULT 0, candidates_top TEXT NOT NULL DEFAULT '', target_kind TEXT, target_host TEXT, target_port INTEGER, target_model TEXT, decision TEXT NOT NULL DEFAULT '', latency_class TEXT NOT NULL DEFAULT 'unproven', tier TEXT NOT NULL DEFAULT '', allow_cloud INTEGER NOT NULL DEFAULT 0, error_code TEXT, why TEXT NOT NULL DEFAULT '', status INTEGER, duration_ms INTEGER, ok INTEGER, err TEXT)",
		);
		raw.close();
		const ledger = new Ledger(path);
		ledger.auditDecision({
			rid: "r-pre-lane",
			ts: new Date().toISOString(),
			actor: "",
			lane: "autow1",
			dialect: "openai",
			hint: "",
			candidates_seen: 0,
			candidates_top: "",
			target_kind: null,
			target_host: null,
			target_port: null,
			target_model: null,
			decision: "denied",
			latency_class: "unproven",
			tier: "",
			allow_cloud: false,
			error_code: "bad_hint",
			why: "test",
		});
		ledger.flush();
		const rows = ledger.auditRows() as Array<{ rid: string; lane: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.lane).toBe("autow1");
		ledger.close();
	});
});
