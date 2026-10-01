// test/server.test.ts — port guard, routes through the real Bun.serve,
// servicemon endpoints, e2e with a temp upstreams config.
import { describe, expect, test } from "bun:test";
import { startMockUpstream } from "./mock.ts";
import {
	resolvePort,
	startServer,
	FORBIDDEN_PORT,
	SHADOW_PORT,
} from "../src/server.ts";

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
});
