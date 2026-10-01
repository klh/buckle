// test/gov-gate.test.ts — W141 gate e2e through a real Bun.serve on a
// scratch port: stable 401/403/429 shapes, key lifecycle over the admin
// API, team ceilings, budget 429s with retry-after, and the JWT validator
// seam against a locally-hosted JWKS endpoint (RS256, WebCrypto-signed).
import { describe, expect, test } from "bun:test";
import { startMockUpstream } from "./mock.ts";
import { startServer } from "../src/server.ts";

const ROOT = "buckle-test-root";

interface GateServer {
	base: string;
	stop(): void;
}

async function startGate(
	upstreamUrl: string,
	jwt?: {
		issuers: Array<{ issuer: string; jwksUri: string }>;
		audience: string;
	},
): Promise<GateServer> {
	const dir = `/tmp/buckle-gate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const cfg = `groups:\n  glm-5.3-flash:\n    - url: ${upstreamUrl}\n      dialect: openai\n`;
	await Bun.write(`${dir}.yaml`, cfg);
	const server = startServer({
		port: 0,
		upstreamsPath: `${dir}.yaml`,
		dbPath: ":memory:",
		auth: { rootKey: ROOT, jwt },
	});
	return {
		base: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	};
}

async function issueViaAdmin(
	base: string,
	body: Record<string, unknown>,
): Promise<{ key: string; keyId: string }> {
	const res = await fetch(`${base}/v1/admin/keys`, {
		method: "POST",
		headers: { authorization: `Bearer ${ROOT}` },
		body: JSON.stringify(body),
	});
	const out = (await res.json()) as { key: string; key_id: string };
	return { key: out.key, keyId: out.key_id };
}

const CHAT_BODY = JSON.stringify({ model: "glm-5.3-flash", stream: false });

async function chat(base: string, token: string | null): Promise<Response> {
	return fetch(`${base}/v1/chat/completions`, {
		method: "POST",
		headers: token === null ? {} : { authorization: `Bearer ${token}` },
		body: CHAT_BODY,
	});
}

describe("gate: auth rejections have stable machine-readable shapes", () => {
	test("missing header → 401 buckle.auth_missing; bad key → 401 buckle.invalid_key", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "x", choices: [], usage: {} }),
		);
		const gate = await startGate(upstream.url);
		const none = await chat(gate.base, null);
		expect(none.status).toBe(401);
		const noneBody = (await none.json()) as { error: { code: string } };
		expect(noneBody.error.code).toBe("buckle.auth_missing");
		const bad = await chat(gate.base, "bksk_nope");
		expect(bad.status).toBe(401);
		const badBody = (await bad.json()) as { error: { code: string } };
		expect(badBody.error.code).toBe("buckle.invalid_key");
		gate.stop();
		upstream.close();
	});

	test("valid key → 200; revoked key → 401 buckle.key_revoked", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({
				id: "ok-1",
				choices: [],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			}),
		);
		const gate = await startGate(upstream.url);
		const { key, keyId } = await issueViaAdmin(gate.base, {
			name: "lane",
			scopes: ["buckle:proxy:WRITE_"],
		});
		const good = await chat(gate.base, key);
		expect(good.status).toBe(200);
		const out = (await good.json()) as { id: string };
		expect(out.id).toBe("ok-1");
		const rev = await fetch(`${gate.base}/v1/admin/keys/${keyId}/revoke`, {
			method: "POST",
			headers: { authorization: `Bearer ${ROOT}` },
		});
		expect(rev.status).toBe(200);
		const after = await chat(gate.base, key);
		expect(after.status).toBe(401);
		const afterBody = (await after.json()) as { error: { code: string } };
		expect(afterBody.error.code).toBe("buckle.key_revoked");
		gate.stop();
		upstream.close();
	});

	test("READ_ key on POST → 403 buckle.insufficient_scope; /health stays public", async () => {
		const upstream = await startMockUpstream(() => Response.json({ id: "x" }));
		const gate = await startGate(upstream.url);
		const { key } = await issueViaAdmin(gate.base, {
			name: "ro",
			scopes: ["buckle:proxy:READ_"],
		});
		const res = await chat(gate.base, key);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("buckle.insufficient_scope");
		const health = await fetch(`${gate.base}/health`);
		expect(health.status).toBe(200);
		gate.stop();
		upstream.close();
	});

	test("rpm budget: over-limit → 429 with retry-after header", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "x", choices: [], usage: {} }),
		);
		const gate = await startGate(upstream.url);
		const { key } = await issueViaAdmin(gate.base, {
			name: "thin",
			scopes: ["buckle:proxy:WRITE_"],
			rpm_limit: 2,
		});
		expect((await chat(gate.base, key)).status).toBe(200);
		expect((await chat(gate.base, key)).status).toBe(200);
		const third = await chat(gate.base, key);
		expect(third.status).toBe(429);
		const ra = third.headers.get("retry-after");
		expect(ra).not.toBeNull();
		expect(Number(ra)).toBeGreaterThanOrEqual(1);
		const body = (await third.json()) as { error: { code: string } };
		expect(body.error.code).toBe("buckle.rate_limited");
		gate.stop();
		upstream.close();
	});

	test("team ceiling tightens what the key allows", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "x", choices: [], usage: {} }),
		);
		const gate = await startGate(upstream.url);
		await fetch(`${gate.base}/v1/admin/teams`, {
			method: "POST",
			headers: { authorization: `Bearer ${ROOT}` },
			body: JSON.stringify({ team_id: "tiny", rpm_ceiling: 1 }),
		});
		const { key } = await issueViaAdmin(gate.base, {
			name: "teamkey",
			team: "tiny",
			scopes: ["buckle:proxy:WRITE_"],
		});
		expect((await chat(gate.base, key)).status).toBe(200);
		const second = await chat(gate.base, key);
		expect(second.status).toBe(429);
		expect(second.headers.get("retry-after")).not.toBeNull();
		gate.stop();
		upstream.close();
	});
});

// ─── JWT validator seam: RS256 via a locally-hosted JWKS ───

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
	const raw = Buffer.from(bytes).toString("base64");
	return raw.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function signJwt(
	priv: CryptoKey,
	claims: Record<string, unknown>,
	kid = "t1",
): Promise<string> {
	const h = b64url(
		enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid })),
	);
	const p = b64url(enc.encode(JSON.stringify(claims)));
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		priv,
		enc.encode(`${h}.${p}`),
	);
	return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

interface JwtFixture {
	jwksUrl: string;
	priv: CryptoKey;
	close(): void;
}

async function startJwks(): Promise<JwtFixture> {
	const kp = (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const pub = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as Record<
		string,
		string
	>;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () =>
			Response.json({
				keys: [{ kid: "t1", kty: "RSA", n: pub.n, e: pub.e }],
			}),
	});
	return {
		jwksUrl: `http://127.0.0.1:${server.port}/jwks`,
		priv: kp.privateKey,
		close: () => server.stop(true),
	};
}

describe("gate: JWT validator seam (IdP-neutral claims, RS256 via JWKS)", () => {
	const baseClaims = () => ({
		iss: "https://idp.test",
		sub: "user-1",
		aud: "buckle",
		exp: Math.floor(Date.now() / 1000) + 300,
		jti: "jt-1",
	});

	test("valid RS256 token with buckle roles → 200; bad sig → 401", async () => {
		const jwks = await startJwks();
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "jx", choices: [], usage: {} }),
		);
		const gate = await startGate(upstream.url, {
			issuers: [{ issuer: "https://idp.test", jwksUri: jwks.jwksUrl }],
			audience: "buckle",
		});
		const tok = await signJwt(jwks.priv, {
			...baseClaims(),
			roles: ["buckle:proxy:WRITE_"],
		});
		const good = await chat(gate.base, tok);
		expect(good.status).toBe(200);
		const bad = await chat(gate.base, `${tok.slice(0, -4)}AAAA`);
		expect(bad.status).toBe(401);
		const badBody = (await bad.json()) as { error: { code: string } };
		expect(badBody.error.code).toBe("buckle.jwt_bad_signature");
		jwks.close();
		gate.stop();
		upstream.close();
	});
});
