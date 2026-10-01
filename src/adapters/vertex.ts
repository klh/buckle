// src/adapters/vertex.ts — the vertex family (W150 tier 2): the W139
// openai-compat pass-through over Vertex AI's OpenAI-compatible endpoint,
// with GCP auth: service-account JWT (RS256, WebCrypto) → oauth2 token
// exchange (cached + single-flight; LiteLLM vertex_llm_base.py:44-210
// auth architecture, our own implementation), or api-key profile (AI
// Studio/gemini rows). adapter_config: { project, region, auth:
// "sa" | "api-key", service_account_json_env?, token_host? } — env NAMES
// only, secrets read at request time.
import type { UpstreamRequest } from "../router.ts";
import type { Deployment } from "../upstreams.ts";
import { RouterError, normalizeUpstreamError } from "./errors.ts";
import { OPENAI_COMPAT } from "./openai-compat.ts";
import type { ChatAdapter, WireCall } from "./types.ts";

export interface VertexAdapterConfig {
	project?: string;
	region?: string;
	/** "sa" (default): service-account JWT exchange; "api-key": AI Studio */
	auth?: "sa" | "api-key";
	/** env var NAME whose value is the SA JSON — default GOOGLE_APPLICATION_CREDENTIALS */
	service_account_json_env?: string;
	/** env var NAME for the api-key profile — default GEMINI_API_KEY */
	api_key_env?: string;
	/** override for tests/local — defaults oauth2.googleapis.com */
	token_host?: string;
}

export function isVertexConfig(v: unknown): v is VertexAdapterConfig {
	return v !== null && typeof v === "object";
}

const enc = new TextEncoder();
const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

/** RS256 JWT for the oauth2 jwt-bearer exchange (SA JSON → PKCS8 key via
 *  WebCrypto). */
export async function saJwt(sa: {
	client_email: string;
	private_key: string;
	aud: string;
	scope: string;
}): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = b64u(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
	const claims = b64u(
		enc.encode(
			JSON.stringify({
				iss: sa.client_email,
				aud: sa.aud,
				scope: sa.scope,
				iat: now,
				exp: now + 3600,
			}),
		),
	);
	return `${header}.${claims}.${await saSign(sa.private_key, `${header}.${claims}`)}`;
}

async function saSign(pem: string, data: string): Promise<string> {
	const keyPem = pem
		.replace(/-----BEGIN PRIVATE KEY-----/, "")
		.replace(/-----END PRIVATE KEY-----/, "")
		.replace(/\s+/g, "");
	const der = Buffer.from(keyPem, "base64");
	const key = await crypto.subtle.importKey(
		"pkcs8",
		der,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		enc.encode(data),
	);
	return b64u(new Uint8Array(sig));
}

const gcpTokens = new Map<
	string,
	{ token: string; exp: number; inflight?: Promise<string> }
>();

/** SA JSON → oauth2 access_token. Cached by account+host, single-flight
 *  per key (the vertex_llm_base.py:90-92 stampede lesson). Refresh
 *  failures throw RouterError("auth") — never crash the attempt loop. */
export async function gcpToken(
	cfg: VertexAdapterConfig,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	const jsonEnv =
		cfg.service_account_json_env ?? "GOOGLE_APPLICATION_CREDENTIALS";
	const raw = process.env[jsonEnv];
	if (!raw) {
		throw new RouterError(
			"auth",
			0,
			`vertex: env ${jsonEnv} must hold the service-account JSON`,
		);
	}
	let sa: { client_email?: string; private_key?: string };
	try {
		sa = JSON.parse(raw) as { client_email?: string; private_key?: string };
	} catch {
		throw new RouterError("auth", 0, `vertex: ${jsonEnv} is not SA JSON`);
	}
	if (!sa.client_email || !sa.private_key) {
		throw new RouterError("auth", 0, `vertex: ${jsonEnv} missing fields`);
	}
	const tokenHost = cfg.token_host ?? "oauth2.googleapis.com";
	const cacheKey = `${sa.client_email}:${tokenHost}`;
	const hit = gcpTokens.get(cacheKey);
	if (hit && hit.exp > Date.now() + 60_000) return hit.token;
	if (hit?.inflight) return hit.inflight;
	// token_host may carry a scheme (tests/local mocks serve plain http)
	const aud = tokenHost.startsWith("http")
		? `${tokenHost}/token`
		: `https://${tokenHost}/token`;

	const p = (async (): Promise<string> => {
		const jwt = await saJwt({
			client_email: sa.client_email as string,
			private_key: sa.private_key as string,
			aud,
			scope: "https://www.googleapis.com/auth/cloud-platform",
		});
		const r = await fetchImpl(aud, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
				assertion: jwt,
			}),
		});
		if (!r.ok) {
			throw new RouterError(
				"auth",
				0,
				`vertex: token exchange failed (${String(r.status)})`,
			);
		}
		const j = (await r.json()) as { access_token?: string };
		if (typeof j.access_token !== "string") {
			throw new RouterError("auth", 0, "vertex: no access_token");
		}
		gcpTokens.set(cacheKey, {
			token: j.access_token,
			exp: Date.now() + 3300_000,
		});
		return j.access_token;
	})();
	if (hit) hit.inflight = p;
	else gcpTokens.set(cacheKey, { token: "", exp: 0, inflight: p });
	return p;
}

async function vertexBuildCall(
	dep: Deployment,
	req: UpstreamRequest,
	body: Record<string, unknown>,
): Promise<WireCall> {
	const cfg = isVertexConfig(dep.adapter_config) ? dep.adapter_config : {};
	if ((cfg.auth ?? "sa") === "sa") {
		const token = await gcpToken(cfg);
		const wire = await OPENAI_COMPAT.buildCall(dep, req, body);
		const url = new URL(wire.url);
		url.pathname =
			`/v1beta1/projects/${cfg.project ?? "-"}` +
			`/locations/${cfg.region ?? "global"}` +
			`/endpoints/openapi/chat/completions`;
		return {
			url: url.toString(),
			headers: { ...wire.headers, authorization: `Bearer ${token}` },
			body: wire.body,
		};
	}
	return OPENAI_COMPAT.buildCall(dep, req, body);
}

/** Vertex family = W139 openai-compat over Vertex AI's OpenAI-compatible
 *  endpoint; sa = service-account JWT exchange, api-key = AI Studio. */
export const VERTEX: ChatAdapter = {
	family: "vertex",
	dialect: "openai",
	caps: OPENAI_COMPAT.caps,
	parseResponse: OPENAI_COMPAT.parseResponse,
	usageOf: OPENAI_COMPAT.usageOf,
	normalizeError: (status, wire, headers) =>
		normalizeUpstreamError("vertex", status, wire, headers),
	buildCall: vertexBuildCall,
};
