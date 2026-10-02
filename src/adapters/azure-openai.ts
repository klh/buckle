// src/adapters/azure-openai.ts — the azure family (W150 tier 2): the W139
// openai-compat pass-through with the azure URL/auth profile on top (W134
// §2: "azure = openai + URL/auth profile"). adapter_config:
// { api_version, deployment?, entra? : { tenant_id, client_id,
// client_secret_env, token_host? } } — secrets stay in env vars; config
// carries NAMES only.
import type { UpstreamRequest } from "../router.ts";
import type { Deployment } from "../upstreams.ts";
import {
	AZURE_TOKEN_HOSTS,
	TOKEN_FETCH_TIMEOUT_MS,
	tokenOrigin,
} from "./egress.ts";
import { normalizeUpstreamError } from "./errors.ts";
import { OPENAI_COMPAT } from "./openai-compat.ts";
import type { ChatAdapter, WireCall } from "./types.ts";

export interface EntraConfig {
	tenant_id: string;
	client_id: string;
	/** env var NAME holding the client secret — never the secret */
	client_secret_env: string;
	/** override — https + allowlisted Entra host only (egress.ts); loopback
	 *  mocks need BUCKLE_TOKEN_HOST_LOOPBACK=on. Default login.microsoftonline.com */
	token_host?: string;
}

export interface AzureAdapterConfig {
	api_version: string;
	/** azure deployment name; defaults to the deployment's model/group */
	deployment?: string;
	/** Entra client-credentials auth (absent = api-key header) */
	entra?: EntraConfig;
}

export function isAzureConfig(v: unknown): v is AzureAdapterConfig {
	if (!v || typeof v !== "object") return false;
	const c = v as Record<string, unknown>;
	return typeof c.api_version === "string" && c.api_version.length > 0;
}

// Entra token cache: tenant:client → cached token with expiry, single
// in-flight refresh per key (LiteLLM vertex_llm_base.py:90-92 lesson —
// concurrent attempts must not stampede the token endpoint).
const entraTokens = new Map<
	string,
	{ token: string; exp: number; inflight?: Promise<string> }
>();

async function entraToken(
	cfg: EntraConfig,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	const key = `${cfg.tenant_id}:${cfg.client_id}`;
	const hit = entraTokens.get(key);
	if (hit && hit.exp > Date.now() + 60_000) return hit.token;
	if (hit?.inflight) return hit.inflight;
	const p = refreshEntra(cfg, fetchImpl);

	if (hit) hit.inflight = p;
	else entraTokens.set(key, { token: "", exp: 0, inflight: p });
	return p;
}

async function refreshEntra(
	cfg: EntraConfig,
	fetchImpl: typeof fetch,
): Promise<string> {
	const key = `${cfg.tenant_id}:${cfg.client_id}`;
	let tokenUrl: string;
	try {
		const origin = tokenOrigin(
			cfg.token_host,
			AZURE_TOKEN_HOSTS[0],
			AZURE_TOKEN_HOSTS,
		);
		tokenUrl = `${origin}/${encodeURIComponent(cfg.tenant_id)}/oauth2/v2.0/token`;
	} catch (e) {
		entraTokens.delete(key);
		throw new Error(`entra token refresh refused: ${(e as Error).message}`);
	}

	const form = new URLSearchParams({
		grant_type: "client_credentials",
		client_id: cfg.client_id,
		client_secret: process.env[cfg.client_secret_env] ?? "",
		scope: "https://cognitiveservices.azure.com/.default",
	});
	let r: Response;
	try {
		r = await fetchImpl(tokenUrl, {
			method: "POST",
			body: form,
			signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
		});
	} catch (e) {
		entraTokens.delete(key);
		throw new Error(`entra token refresh failed: ${(e as Error).message}`);
	}
	if (!r.ok) {
		entraTokens.delete(key);
		throw new Error(`entra token refresh failed (${String(r.status)})`);
	}
	const j = (await r.json().catch(() => ({}))) as { access_token?: string };
	if (typeof j.access_token !== "string") {
		entraTokens.delete(key);
		throw new Error("entra token refresh: no access_token in response");
	}
	// azure access tokens live ~55-90min; cache with a generous early skew
	entraTokens.set(key, { token: j.access_token, exp: Date.now() + 3300_000 });
	return j.access_token;
}

/** Deployment URL → azure chat URL: api-version query + deployment path
 *  (a base already containing /openai/deployments/ keeps its path). */
function azureUrl(base: string, deployment: string, apiVersion: string): URL {
	const u = new URL(base);
	if (!u.pathname.includes("/openai/deployments/")) {
		u.pathname = `/openai/deployments/${deployment}/chat/completions`;
	}
	u.searchParams.set("api-version", apiVersion);
	return u;
}

async function azureBuildCall(
	dep: Deployment,
	req: UpstreamRequest,
	body: Record<string, unknown>,
): Promise<WireCall> {
	const cfg = isAzureConfig(dep.adapter_config)
		? dep.adapter_config
		: { api_version: "preview" };
	const wire = await OPENAI_COMPAT.buildCall(dep, req, body);
	const deployment = cfg.deployment ?? dep.model ?? dep.group;
	const url = azureUrl(dep.url, deployment, cfg.api_version);
	const headers = { ...wire.headers };

	if (cfg.entra) {
		const token = await entraToken(cfg.entra);
		headers.authorization = `Bearer ${token}`;
	} else if (dep.api_key_env) {
		const key = process.env[dep.api_key_env];
		if (key) headers["api-key"] = key;
	}
	return { ...wire, url: url.toString(), headers };
}

/** Azure family = W139 openai-compat + URL/auth profile. api-key header by
 *  default; optional Entra client-credentials via adapter_config.entra. */
export const AZURE_OPENAI: ChatAdapter = {
	family: "azure-openai",
	dialect: "openai",
	caps: OPENAI_COMPAT.caps,
	parseResponse: OPENAI_COMPAT.parseResponse,
	usageOf: OPENAI_COMPAT.usageOf,
	normalizeError: (status, wire, headers) =>
		normalizeUpstreamError("azure-openai", status, wire, headers),
	buildCall: azureBuildCall,
};
