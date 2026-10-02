// test/egress.test.ts — review #13 §1.3 SSRF / credential hygiene: token
// endpoints https + allowlisted; loopback mocks only behind the explicit
// opt-in; upstream base URLs https or loopback http (or operator-listed).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { AZURE_OPENAI } from "../src/adapters/azure-openai.ts";
import {
	AZURE_TOKEN_HOSTS,
	GCP_TOKEN_HOSTS,
	tokenOrigin,
	validateUpstreamUrl,
} from "../src/adapters/egress.ts";
import { gcpToken } from "../src/adapters/vertex.ts";
import { loadUpstreams } from "../src/upstreams.ts";

const ENV = [
	"BUCKLE_TOKEN_HOST_LOOPBACK",
	"BUCKLE_TOKEN_HOSTS",
	"BUCKLE_HTTP_UPSTREAM_HOSTS",
];
afterEach(() => {
	for (const k of ENV) delete process.env[k];
});

describe("tokenOrigin", () => {
	const az = (h?: string): string =>
		tokenOrigin(h, AZURE_TOKEN_HOSTS[0], AZURE_TOKEN_HOSTS);

	test("default + allowlisted hosts → https origin", () => {
		expect(az()).toBe("https://login.microsoftonline.com");
		expect(az("login.microsoftonline.us")).toBe(
			"https://login.microsoftonline.us",
		);
		expect(az("https://login.chinacloudapi.cn")).toBe(
			"https://login.chinacloudapi.cn",
		);
	});

	test("arbitrary / http / path-smuggling hosts refused", () => {
		expect(() => az("evil.example.com")).toThrow(/allowlist/);
		expect(() => az("http://login.microsoftonline.com")).toThrow(/https/);
		expect(() => az("login.microsoftonline.com.evil.io")).toThrow(/allowlist/);
		expect(() => az("https://login.microsoftonline.com/x")).toThrow(
			/bare host/,
		);
		expect(() => az("https://u:p@login.microsoftonline.com")).toThrow(
			/bare host/,
		);
		expect(() => az("http://127.0.0.1:9")).toThrow(/https/);
	});

	test("loopback only with BUCKLE_TOKEN_HOST_LOOPBACK=on", () => {
		process.env.BUCKLE_TOKEN_HOST_LOOPBACK = "on";
		expect(az("http://127.0.0.1:9")).toBe("http://127.0.0.1:9");
		expect(() => az("http://10.0.0.1")).toThrow(/https/);
	});

	test("BUCKLE_TOKEN_HOSTS extends the allowlist (https only)", () => {
		process.env.BUCKLE_TOKEN_HOSTS = "sts.corp.example";
		expect(
			tokenOrigin("sts.corp.example", GCP_TOKEN_HOSTS[0], GCP_TOKEN_HOSTS),
		).toBe("https://sts.corp.example");
		expect(() =>
			tokenOrigin(
				"http://sts.corp.example",
				GCP_TOKEN_HOSTS[0],
				GCP_TOKEN_HOSTS,
			),
		).toThrow(/https/);
	});
});

describe("adapters refuse disallowed token hosts before any fetch", () => {
	test("azure entra: client_secret never leaves for an unlisted host", async () => {
		let hits = 0;
		const evil = Bun.serve({
			port: 0,
			fetch: () => {
				hits++;
				return Response.json({ access_token: "stolen" });
			},
		});
		const call = AZURE_OPENAI.buildCall(
			{
				group: "az",
				url: "https://res.openai.azure.com",
				dialect: "openai",
				adapter_config: {
					api_version: "2024-10-21",
					entra: {
						tenant_id: "t",
						client_id: `c-${Date.now()}`,
						client_secret_env: "BUCKLE_TEST_SECRET",
						token_host: `http://127.0.0.1:${evil.port}`,
					},
				},
			},
			{ path: "/v1/chat/completions" } as never,
			{ model: "m", messages: [] },
		);
		await expect(call).rejects.toThrow(/refused/);
		expect(hits).toBe(0);
		evil.stop(true);
	});

	test("vertex: unlisted token_host → auth RouterError, no exchange", async () => {
		process.env.BUCKLE_TEST_EGRESS_SA = JSON.stringify({
			client_email: "x@y.iam.gserviceaccount.com",
			private_key: "unused",
		});
		await expect(
			gcpToken({
				token_host: "attacker.example",
				service_account_json_env: "BUCKLE_TEST_EGRESS_SA",
			}),
		).rejects.toMatchObject({ kind: "auth" });
	});

	test("azure entra via loopback mock (opt-in) carries a timeout signal", async () => {
		process.env.BUCKLE_TOKEN_HOST_LOOPBACK = "on";
		process.env.BUCKLE_TEST_SECRET = "s";
		const mock = Bun.serve({
			port: 0,
			fetch: () => Response.json({ access_token: "tok-az" }),
		});
		const real = globalThis.fetch;
		let signalled = false;
		globalThis.fetch = ((u: string, init?: RequestInit) => {
			signalled = init?.signal instanceof AbortSignal;
			return real(u, init);
		}) as typeof fetch;
		try {
			const call = await AZURE_OPENAI.buildCall(
				{
					group: "az",
					url: "https://res.openai.azure.com",
					dialect: "openai",
					adapter_config: {
						api_version: "2024-10-21",
						entra: {
							tenant_id: "t/../../x",
							client_id: `c-ok-${Date.now()}`,
							client_secret_env: "BUCKLE_TEST_SECRET",
							token_host: `http://127.0.0.1:${mock.port}`,
						},
					},
				},
				{ path: "/v1/chat/completions" } as never,
				{ model: "m", messages: [] },
			);
			expect(call.headers.authorization).toBe("Bearer tok-az");
			expect(signalled).toBe(true);
		} finally {
			globalThis.fetch = real;
			mock.stop(true);
		}
	});
});

describe("upstream base URL law", () => {
	test("https anywhere; http only to loopback or operator-listed hosts", () => {
		expect(() =>
			validateUpstreamUrl("https://api.anthropic.com"),
		).not.toThrow();
		expect(() => validateUpstreamUrl("http://127.0.0.1:8902")).not.toThrow();
		expect(() => validateUpstreamUrl("http://localhost:1")).not.toThrow();
		expect(() => validateUpstreamUrl("http://[::1]:1")).not.toThrow();
		expect(() => validateUpstreamUrl("http://169.254.169.254")).toThrow(/http/);
		expect(() => validateUpstreamUrl("file:///etc/passwd")).toThrow(/scheme/);
		expect(() => validateUpstreamUrl("https://u:p@h.example")).toThrow(
			/credentials/,
		);
		process.env.BUCKLE_HTTP_UPSTREAM_HOSTS = "gpu-box.lan";
		expect(() => validateUpstreamUrl("http://gpu-box.lan:8000")).not.toThrow();
	});

	test("loadUpstreams fails closed naming the group", () => {
		const dir = `/tmp/buckle-egress-${Date.now()}`;
		mkdirSync(dir, { recursive: true });
		const p = `${dir}/u.yaml`;
		writeFileSync(
			p,
			"groups:\n  meta:\n    - url: http://169.254.169.254\n      dialect: openai\n",
		);
		expect(() => loadUpstreams(p)).toThrow(/group "meta".*refused/);
		writeFileSync(
			p,
			"groups:\n  az:\n    - url: https://r.openai.azure.com\n      dialect: openai\n" +
				"      adapter: azure-openai\n      adapter_config:\n        api_version: v\n" +
				"        entra:\n          tenant_id: t\n          client_id: c\n" +
				"          client_secret_env: S\n          token_host: evil.example\n",
		);
		expect(() => loadUpstreams(p)).toThrow(/group "az".*allowlist/);
	});

	test("the committed upstreams.yaml passes the law", () => {
		expect(() => loadUpstreams()).not.toThrow();
	});
});
