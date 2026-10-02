// test/adapters-catalog.test.ts — W150: catalog membership/mapping goldens,
// count smoke, catch-all derivation, and one tier-2 adapter per family
// (azure Entra/api-key, bedrock SigV4 by independent-implementation
// agreement, vertex SA-JWT/token exchange against local mocks).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AZURE_OPENAI, isAzureConfig } from "../src/adapters/azure-openai.ts";
import { BEDROCK, sigv4Sign } from "../src/adapters/bedrock.ts";
import {
	CATALOG_TABLE,
	catalogLookup,
	catalogSummary,
	resolveCatalogFamily,
} from "../src/adapters/catalog.ts";

import { resolveAdapter } from "../src/adapters/index.ts";

import { gcpToken, saJwt, VERTEX } from "../src/adapters/vertex.ts";

/** fresh exportable RSA keypair as a SA-style PKCS8 PEM (per-call: unique
 *  client_email + fresh key keeps the module-level token caches disjoint
 *  across tests) */
async function rsaPem(): Promise<string> {
	const kp = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	);
	const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
	return `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString("base64")}\n-----END PRIVATE KEY-----\n`;
}

describe("W150 catalog", () => {
	test("count smoke: tiers and families sum to the total", () => {
		const s = catalogSummary();
		expect(s.count).toBe(108);
		expect(s.byTier[1] + s.byTier[2] + s.byTier[3]).toBe(s.count);
		expect(s.byTier[1]).toBe(2);
		expect(s.byTier[2]).toBe(8);
		expect(s.byTier[3]).toBe(98);
		const famSum = Object.values(s.byFamily).reduce((a, b) => a + b, 0);
		expect(famSum).toBe(s.count);
	});

	test("family-mapping goldens (samples per family)", () => {
		expect(catalogLookup("openai")).toEqual({
			name: "openai",
			family: "openai-compat",
			tier: 1,
			auth: "bearer",
			env: "OPENAI_API_KEY",
			docs: "providers/openai",
		});
		expect(catalogLookup("anthropic")?.family).toBe("anthropic");
		expect(catalogLookup("azure")?.family).toBe("azure-openai");
		expect(catalogLookup("azure_ai")?.tier).toBe(2);
		expect(catalogLookup("bedrock")?.auth).toBe("signed");
		expect(catalogLookup("sagemaker")?.family).toBe("bedrock");
		expect(catalogLookup("amazon_nova")?.family).toBe("bedrock");
		expect(catalogLookup("vertex_ai")?.family).toBe("vertex");
		expect(catalogLookup("vertex_ai")?.auth).toBe("token-exchange");
		expect(catalogLookup("gemini")?.family).toBe("vertex");
		expect(catalogLookup("gemini")?.auth).toBe("api-key-header");
		expect(catalogLookup("openrouter")?.tier).toBe(3);
		expect(catalogLookup("dashscope")?.family).toBe("openai-compat");
	});

	test("twins collapse; excluded classes and flashx absent", () => {
		expect(catalogLookup("ollama_chat")).toBeNull();
		expect(catalogLookup("hosted_vllm")).toBeNull();
		expect(catalogLookup("qwencloud")).toBeNull();
		expect(catalogLookup("watsonx_text")).toBeNull();
		expect(catalogLookup("milvus")).toBeNull();
		expect(catalogLookup("deepgram")).toBeNull();
		expect(catalogLookup("recraft")).toBeNull();
		expect(catalogLookup("helicone")).toBeNull();
		expect(catalogLookup("langgraph")).toBeNull();
		expect(catalogLookup("flashx")).toBeNull();
	});

	test("names unique; env fields are NAMES not values", () => {
		const seen = new Set<string>();
		for (const r of CATALOG_TABLE) {
			expect(seen.has(r.name)).toBe(false);
			seen.add(r.name);
			for (const env of [r.env]) {
				if (env === undefined) continue;
				expect(env).toMatch(/^[A-Z][A-Z0-9_]*$/);
				expect(env.length).toBeGreaterThan(3);
			}
		}
	});
});

describe("W150 resolution", () => {
	test("catalog provider name resolves to its family", () => {
		expect(
			resolveAdapter({ adapter: "openrouter", dialect: "openai" }).family,
		).toBe("openai-compat");
		expect(
			resolveAdapter({ adapter: "vertex_ai", dialect: "openai" }).family,
		).toBe("vertex");
		expect(resolveCatalogFamily("bedrock", false)).toBe("bedrock");
	});

	test("catch-all: unknown + explicit adapter_config → openai-compat; unknown alone fails closed", () => {
		expect(
			resolveAdapter({
				adapter: "brand-new-provider",
				dialect: "openai",
				adapter_config: { base_url_hint: "https://api.example.com/v1" },
			}).family,
		).toBe("openai-compat");
		expect(resolveCatalogFamily("brand-new-provider", true)).toBe(
			"openai-compat",
		);
		expect(() => resolveCatalogFamily("brand-new-provider", false)).toThrow(
			/unknown adapter/,
		);
		expect(() =>
			resolveAdapter({ adapter: "nope", dialect: "openai" }),
		).toThrow(/unknown adapter/);
		expect(resolveAdapter({ dialect: "openai" }).family).toBe("openai-compat");
	});
});

describe("W150 azure-openai", () => {
	const dep = {
		group: "corp-azure",
		url: "https://corp.example.openai.azure.com",
		dialect: "openai" as const,
		model: "gpt-5.2",
		api_key_env: "BUCKLE_TEST_AZ_KEY",
		adapter_config: {
			api_version: "2026-03-01-preview",
			deployment: "corp-deploy",
		},
	};

	test("api-key profile: deployment path + api-version query + api-key header", async () => {
		process.env.BUCKLE_TEST_AZ_KEY = "test-key-material";
		const call = await AZURE_OPENAI.buildCall(
			dep,
			{ path: "/v1/chat/completions" } as never,
			{ model: "alias", messages: [] },
		);
		const u = new URL(call.url);
		expect(u.pathname).toBe("/openai/deployments/corp-deploy/chat/completions");
		expect(u.searchParams.get("api-version")).toBe("2026-03-01-preview");
		expect(call.headers["api-key"]).toBe("test-key-material");
		expect(JSON.parse(call.body).model).toBe("gpt-5.2");
	});

	test("isAzureConfig guard", () => {
		expect(isAzureConfig({ api_version: "preview" })).toBe(true);
		expect(isAzureConfig({})).toBe(false);
		expect(isAzureConfig(null)).toBe(false);
	});
});
describe("W150 bedrock", () => {
	test("sigv4 agrees with an independent node:crypto derivation", async () => {
		const url = new URL(
			"https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions",
		);
		const body = JSON.stringify({ model: "m", messages: [] });
		const now = new Date("2026-10-01T12:00:00Z");
		const signed = await sigv4Sign({
			method: "POST",
			url,
			body,
			accessKey: "AKIDEXAMPLE",
			secretKey: "wJalrXUtnFEMI",
			region: "us-east-1",
			service: "bedrock",
			now,
		});
		const amzDate = "20261001T120000Z";
		const date = "20261001";
		const hmacK = (k: Buffer | Uint8Array, d: string): Buffer =>
			createHmac("sha256", k).update(d).digest();
		const kDate = hmacK(Buffer.from("AWS4wJalrXUtnFEMI"), date);
		const kRegion = hmacK(kDate, "us-east-1");
		const kService = hmacK(kRegion, "bedrock");
		const kSigning = hmacK(kService, "aws4_request");
		const { createHash } = await import("node:crypto");
		const payloadHash = createHash("sha256").update(body).digest("hex");
		const canonical = [
			"POST",
			url.pathname,
			"",
			`host:${url.host}\nx-amz-date:${amzDate}\n`,
			"host;x-amz-date",
			payloadHash,
		].join("\n");
		const stringToSign = [
			"AWS4-HMAC-SHA256",
			amzDate,
			`${date}/us-east-1/bedrock/aws4_request`,
			createHash("sha256").update(canonical).digest("hex"),
		].join("\n");
		const expected = createHmac("sha256", kSigning)
			.update(stringToSign)
			.digest("hex");
		const got = signed.headers.authorization;
		expect(got).toContain(`Signature=${expected}`);
		expect(got).toContain("SignedHeaders=host;x-amz-date");
		expect(signed.headers["x-amz-date"]).toBe(amzDate);
	});

	test("buildCall: URL shape + signed headers + session token", async () => {
		process.env.BUCKLE_TEST_AWS_ID = "AKIDEXAMPLE";
		process.env.BUCKLE_TEST_AWS_SECRET = "wJalrXUtnFEMI";
		process.env.BUCKLE_TEST_AWS_SESSION = "st-123";
		const call = await BEDROCK.buildCall(
			{
				group: "aws",
				url: "https://127.0.0.1:9",
				dialect: "openai" as const,
				model: "us.anthropic.claude-sonnet-5",
				adapter_config: {
					region: "us-east-1",
					access_key_env: "BUCKLE_TEST_AWS_ID",
					secret_key_env: "BUCKLE_TEST_AWS_SECRET",
					session_token_env: "BUCKLE_TEST_AWS_SESSION",
				},
			},
			{ path: "/v1/chat/completions" } as never,
			{ model: "alias", messages: [] },
		);
		const u = new URL(call.url);
		expect(u.host).toBe("bedrock-runtime.us-east-1.amazonaws.com");
		expect(u.pathname).toBe("/openai/v1/chat/completions");
		expect(call.headers.authorization).toStartWith("AWS4-HMAC-SHA256 ");
		expect(call.headers["x-amz-security-token"]).toBe("st-123");
	});

	test("missing creds fail closed with an auth RouterError", async () => {
		const noCreds = BEDROCK.buildCall(
			{
				group: "aws2",
				url: "https://127.0.0.1:9",
				dialect: "openai" as const,
				adapter_config: {
					region: "us-east-1",
					access_key_env: "BUCKLE_TEST_AWS_ABSENT",
					secret_key_env: "BUCKLE_TEST_AWS_ABSENT",
				},
			},
			{ path: "/v1/chat/completions" } as never,
			{ messages: [] },
		);
		expect(
			await noCreds.then(
				() => null,
				(e) => e,
			),
		).toMatchObject({
			kind: "auth",
		});
	});
});

describe("W150 vertex", () => {
	// loopback token mocks are an explicit opt-in (adapters/egress.ts)
	beforeAll(() => {
		process.env.BUCKLE_TOKEN_HOST_LOOPBACK = "on";
	});
	afterAll(() => {
		delete process.env.BUCKLE_TOKEN_HOST_LOOPBACK;
	});
	test("saJwt: RS256 signature verifies against the SA public key", async () => {
		const kp = await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"],
		);
		const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
		const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString("base64")}\n-----END PRIVATE KEY-----\n`;
		const jwt = await saJwt({
			client_email: "w150-sa@test.iam.gserviceaccount.com",
			private_key: pem,
			aud: "https://oauth2.test/token",
			scope: "https://www.googleapis.com/auth/cloud-platform",
		});
		const parts = jwt.split(".");
		expect(parts).toHaveLength(3);
		const claims = JSON.parse(
			Buffer.from(parts[1] ?? "", "base64url").toString(),
		);

		expect(claims.iss).toBe("w150-sa@test.iam.gserviceaccount.com");
		expect(claims.aud).toBe("https://oauth2.test/token");
		expect(claims.exp - claims.iat).toBe(3600);
		const header = JSON.parse(
			Buffer.from(parts[0] ?? "", "base64url").toString(),
		);

		expect(header.alg).toBe("RS256");
		const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
		const pub = await crypto.subtle.importKey(
			"spki",
			spki,
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		const ok = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			pub,
			Buffer.from(parts[2] ?? "", "base64url"),

			new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
		);
		expect(ok).toBe(true);
	});

	test("gcpToken: mock exchange + single-flight (one POST, shared result)", async () => {
		let tokenPosts = 0;
		const mock = Bun.serve({
			port: 0,
			fetch: () => {
				tokenPosts++;
				return Response.json({ access_token: `tok-${tokenPosts}` });
			},
		});
		const kp = await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"],
		);
		const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
		const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString("base64")}\n-----END PRIVATE KEY-----\n`;
		process.env.BUCKLE_TEST_W150_SA = JSON.stringify({
			client_email: `w150-${Date.now()}@test.iam.gserviceaccount.com`,
			private_key: pem,
		});
		const cfg = {
			token_host: `http://127.0.0.1:${mock.port}`,
			service_account_json_env: "BUCKLE_TEST_W150_SA",
		};

		const [a, b] = await Promise.all([gcpToken(cfg), gcpToken(cfg)]);
		expect(a).toBe(b);
		expect(tokenPosts).toBe(1);
		mock.stop(true);
	});

	test("vertex buildCall: openapi endpoint path + bearer from the exchange", async () => {
		const mock = Bun.serve({
			port: 0,
			fetch: () => Response.json({ access_token: "tok-1" }),
		});
		process.env.BUCKLE_TEST_W150_SA2 = JSON.stringify({
			client_email: `w150url-${Date.now()}@test.iam.gserviceaccount.com`,
			private_key: await rsaPem(),
		});

		const call = await VERTEX.buildCall(
			{
				group: "vertex-example",
				url: "https://aiplatform.googleapis.com",
				dialect: "openai" as const,
				model: "gemini-3-flash",
				adapter_config: {
					project: "proj-1",
					region: "global",
					token_host: `http://127.0.0.1:${mock.port}`,
					service_account_json_env: "BUCKLE_TEST_W150_SA2",
				},
			},
			{ path: "/v1/chat/completions" } as never,
			{ model: "alias", messages: [] },
		);
		const u = new URL(call.url);
		expect(u.pathname).toBe(
			"/v1beta1/projects/proj-1/locations/global/endpoints/openapi/chat/completions",
		);
		expect(call.headers.authorization).toBe("Bearer tok-1");
		mock.stop(true);
	});
});
