// test/server.test.ts — port guard, routes through the real Bun.serve,
// servicemon endpoints, e2e with a temp upstreams config.
import { describe, expect, test } from "bun:test";
import {
	FORBIDDEN_PORT,
	MAX_REQUEST_BODY_BYTES,
	resolvePort,
	SHADOW_PORT,
	startServer,
} from "../src/server.ts";
import { startMockUpstream } from "./mock.ts";

describe("resolvePort guard", () => {
	test("4100 refused from explicit arg", () => {
		expect(() => resolvePort(4100)).toThrow("refuses");
	});

	test("4100 refused from BUCKLE_PORT env", () => {
		const prior = process.env.BUCKLE_PORT;
		process.env.BUCKLE_PORT = "4100";
		try {
			expect(() => resolvePort()).toThrow("refused");
		} finally {
			if (prior === undefined) delete process.env.BUCKLE_PORT;
			else process.env.BUCKLE_PORT = prior;
		}
	});
});

describe("servicemon endpoints", () => {
	test("default ports: SHADOW 4101 vs FORBIDDEN 4100", () => {
		expect(SHADOW_PORT).toBe(4101);
		expect(FORBIDDEN_PORT).toBe(4100);
	});

	test("resolvePort defaults to the shadow port", () => {
		const prior = process.env.BUCKLE_PORT;
		delete process.env.BUCKLE_PORT;
		try {
			expect(resolvePort()).toBe(4101);
		} finally {
			if (prior !== undefined) process.env.BUCKLE_PORT = prior;
		}
	});
});

describe("e2e through Bun.serve", () => {
	test("proxied round-trip with a temp upstreams config", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({
				id: "srv-1",
				choices: [],
				usage: { prompt_tokens: 4, completion_tokens: 1 },
			}),
		);
		const dir = `/tmp/buckle-test-${Date.now()}`;
		const cfg = `groups:\n  glm-5.3-flash:\n    - url: ${upstream.url}\n      dialect: openai\n`;
		await Bun.write(`${dir}/upstreams.yaml`, cfg);
		const server = startServer({
			port: 0,
			upstreamsPath: `${dir}/upstreams.yaml`,
			dbPath: ":memory:",
			auth: { rootKey: "test-key" },
		});
		const base = `http://127.0.0.1:${server.port}`;
		const res = await fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			headers: { authorization: "Bearer test-key" },
			body: JSON.stringify({ model: "glm-5.3-flash", stream: false }),
		});
		expect(res.status).toBe(200);
		const out = (await res.json()) as { id: string };
		expect(out.id).toBe("srv-1");
		const models = await fetch(`${base}/v1/models`, {
			headers: { authorization: "Bearer test-key" },
		});
		const list = (await models.json()) as { data: Array<{ id: string }> };
		expect(list.data.map((m) => m.id)).toContain("glm-5.3-flash");
		const status = await fetch(`${base}/status`);
		const st = (await status.json()) as { service: string };
		expect(st.service).toBe("buckle");
		const metrics = await (await fetch(`${base}/metrics`)).text();
		expect(metrics).toContain("http_requests_total");
		server.stop(true);
		upstream.close();
	});

	test("over-cap request body → 413 before the gate (W199.2 body cap)", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "x", choices: [], usage: {} }),
		);
		const dir = `/tmp/buckle-cap-${Date.now()}`;
		const cfg = `groups:\n  glm-5.3-flash:\n    - url: ${upstream.url}\n      dialect: openai\n`;
		await Bun.write(`${dir}/upstreams.yaml`, cfg);
		const server = startServer({
			port: 0,
			upstreamsPath: `${dir}/upstreams.yaml`,
			dbPath: ":memory:",
			auth: { rootKey: "cap-key" },
		});
		const base = `http://127.0.0.1:${server.port}`;
		const big = "x".repeat(MAX_REQUEST_BODY_BYTES + 1);
		const res = await fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			headers: { authorization: "Bearer cap-key" },
			body: big,
		});
		expect(res.status).toBe(413);
		server.stop(true);
		upstream.close();
	});
});

describe("http citizenship at the observability seam (W155)", () => {
	test("OPTIONS → 204 + Allow; wrong method → 405 + Allow on /status and /metrics", async () => {
		const upstream = await startMockUpstream(() => Response.json({ id: "x" }));
		const dir = `/tmp/buckle-cit-${Date.now()}`;
		const cfg = `groups:\n  glm-5.3-flash:\n    - url: ${upstream.url}\n      dialect: openai\n`;
		await Bun.write(`${dir}/upstreams.yaml`, cfg);
		const server = startServer({
			port: 0,
			upstreamsPath: `${dir}/upstreams.yaml`,
			dbPath: ":memory:",
			auth: { rootKey: "cit-key" },
		});
		const base = `http://127.0.0.1:${server.port}`;
		const opt = await fetch(`${base}/status`, { method: "OPTIONS" });
		expect(opt.status).toBe(204);
		expect(opt.headers.get("allow")).toContain("OPTIONS");
		const del = await fetch(`${base}/status`, { method: "DELETE" });
		expect(del.status).toBe(405);
		expect(del.headers.get("allow")).toContain("GET");
		const put = await fetch(`${base}/metrics`, { method: "PUT" });
		expect(put.status).toBe(405);
		server.stop(true);
		upstream.close();
	});

	test("GET /status carries a strong ETag; If-None-Match → 304", async () => {
		const upstream = await startMockUpstream(() => Response.json({ id: "x" }));
		const dir = `/tmp/buckle-etag-${Date.now()}`;
		const cfg = `groups:\n  glm-5.3-flash:\n    - url: ${upstream.url}\n      dialect: openai\n`;
		await Bun.write(`${dir}/upstreams.yaml`, cfg);
		const server = startServer({
			port: 0,
			upstreamsPath: `${dir}/upstreams.yaml`,
			dbPath: ":memory:",
			auth: { rootKey: "cit-key" },
		});
		const base = `http://127.0.0.1:${server.port}`;
		const r1 = await fetch(`${base}/status`);
		expect(r1.status).toBe(200);
		const etag = r1.headers.get("etag");
		expect(etag).not.toBeNull();
		const r2 = await fetch(`${base}/status`, {
			headers: { "if-none-match": etag ?? "" },
		});
		expect(r2.status).toBe(304);
		expect(r2.headers.get("etag")).toBe(etag);
		server.stop(true);
		upstream.close();
	});
});
