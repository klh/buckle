// src/adapters/bedrock.ts — the bedrock family (W150 tier 2): the W139
// openai-compat pass-through over Bedrock's OpenAI-compatible endpoint
// (/openai/v1/chat/completions) with SigV4 request signing (W134 §3.1:
// auth is the real cost; vendoring declined — own WebCrypto SigV4, tested
// by independent-implementation agreement, see test). adapter_config:
// { region, access_key_env?, secret_key_env?, session_token_env?,
// model_id? } — env var NAMES only, read at request time.
import type { UpstreamRequest } from "../router.ts";
import type { Deployment } from "../upstreams.ts";
import { RouterError, normalizeUpstreamError } from "./errors.ts";
import { OPENAI_COMPAT } from "./openai-compat.ts";
import type { ChatAdapter, WireCall } from "./types.ts";

export interface BedrockAdapterConfig {
	region: string;
	/** env var NAMES — defaults are the standard AWS ones */
	access_key_env?: string;
	secret_key_env?: string;
	session_token_env?: string;
	/** override for tests/local signing checks — defaults bedrock-runtime */
	host?: string;
}

export function isBedrockConfig(v: unknown): v is BedrockAdapterConfig {
	if (!v || typeof v !== "object") return false;
	const c = v as Record<string, unknown>;
	return typeof c.region === "string" && c.region.length > 0;
}

const enc = new TextEncoder();

async function sha256Hex(data: string | Uint8Array): Promise<string> {
	const buf = await crypto.subtle.digest(
		"SHA-256",
		typeof data === "string" ? enc.encode(data) : new Uint8Array(data),
		// W150 tsc fix: BufferSource needs a plain ArrayBuffer backing
	);
	return [...new Uint8Array(buf)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function hmac(
	key: Uint8Array | ArrayBuffer,
	data: string,
): Promise<Uint8Array> {
	const k = await crypto.subtle.importKey(
		"raw",
		new Uint8Array(key),
		// W150 tsc fix: importKey wants a plain ArrayBuffer backing

		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", k, enc.encode(data));
	return new Uint8Array(sig);
}

/** SigV4 signing key: kSecret → kDate → kRegion → kService → kSigning. */
async function signingKey(
	secret: string,
	date: string,
	region: string,
	service: string,
): Promise<Uint8Array> {
	const kDate = await hmac(enc.encode(`AWS4${secret}`), date);
	const kRegion = await hmac(kDate, region);
	const kService = await hmac(kRegion, service);
	return hmac(kService, "aws4_request");
}

export interface SignedRequest {
	headers: Record<string, string>;
	/** canonical-request hash — test seam (independent-impl agreement) */
	payloadHash: string;
}

/** SigV4 over a POST: host + x-amz-date (+ x-amz-security-token) signed,
 *  payload hashed. Returns headers incl. Authorization + payload hash. */
export async function sigv4Sign(args: {
	method: string;
	url: URL;
	headers?: Record<string, string>;
	body: string;
	accessKey: string;
	secretKey: string;
	sessionToken?: string;
	region: string;
	service: string;
	now?: Date;
}): Promise<SignedRequest> {
	const now = args.now ?? new Date();
	const amzDate = now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
	const payloadHash = await sha256Hex(args.body);
	const headers: Record<string, string> = {
		"x-amz-date": amzDate,
		host: args.url.host,
	};
	if (args.sessionToken) headers["x-amz-security-token"] = args.sessionToken;

	return finishSign(args, headers, payloadHash, amzDate);
}

async function finishSign(
	args: {
		method: string;
		url: URL;
		body: string;
		accessKey: string;
		secretKey: string;
		region: string;
		service: string;
	},
	headers: Record<string, string>,
	payloadHash: string,
	amzDate: string,
): Promise<SignedRequest> {
	const date = amzDate.slice(0, 8);

	const sortedNames = Object.keys(headers).sort();
	const canonicalHeaders = sortedNames
		.map((n) => `${n}:${headers[n]?.trim() ?? ""}\n`)
		.join("");

	const signedHeaders = sortedNames.join(";");
	const canonical = [
		args.method,
		args.url.pathname,
		"",
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join("\n");
	const scope = `${date}/${args.region}/${args.service}/aws4_request`;
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		await sha256Hex(canonical),
	].join("\n");
	const key = await signingKey(args.secretKey, date, args.region, args.service);
	const sig = bytesToHex(await hmac(key, stringToSign));
	const auth =
		`AWS4-HMAC-SHA256 Credential=${args.accessKey}/${scope}, ` +
		`SignedHeaders=${signedHeaders}, Signature=${sig}`;
	return { headers: { ...headers, authorization: auth }, payloadHash };
}

function bytesToHex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// W150: bedrock buildCall + adapter object — the sigv4 seam above is only
// used here; landing the tier-2 bedrock adapter per the W150 brief.
async function bedrockBuildCall(
	dep: Deployment,
	req: UpstreamRequest,
	body: Record<string, unknown>,
): Promise<WireCall> {
	const cfg = isBedrockConfig(dep.adapter_config)
		? dep.adapter_config
		: {
				region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "",
			};
	if (cfg.region.length === 0) {
		throw new RouterError(
			"auth",
			0,
			"bedrock: adapter_config.region (or AWS_REGION) required",
		);
	}
	const accessKey = process.env[cfg.access_key_env ?? "AWS_ACCESS_KEY_ID"];
	const secretKey = process.env[cfg.secret_key_env ?? "AWS_SECRET_ACCESS_KEY"];
	if (!accessKey || !secretKey) {
		throw new RouterError(
			"auth",
			0,
			"bedrock: AWS credentials missing from env (names in adapter_config)",
		);
	}
	const wire = await OPENAI_COMPAT.buildCall(dep, req, body);
	const host = cfg.host ?? `bedrock-runtime.${cfg.region}.amazonaws.com`;
	// Bedrock's OpenAI-compatible surface: /openai/v1/chat/completions —
	// the ingress /v1 prefix maps onto /openai/v1
	const suffix = new URL(wire.url).pathname.replace(/^\/v1/, "");
	const url = new URL(`/openai/v1${suffix}`, `https://${host}`);

	const signed = await sigv4Sign({
		method: "POST",
		url,
		body: wire.body,
		accessKey,
		secretKey,
		sessionToken: cfg.session_token_env
			? process.env[cfg.session_token_env]
			: process.env.AWS_SESSION_TOKEN,
		region: cfg.region,
		service: "bedrock",
	});
	return {
		url: url.toString(),
		headers: { "content-type": "application/json", ...signed.headers },
		body: wire.body,
	};
}

/** Bedrock family = W139 openai-compat over the OpenAI-compatible Bedrock
 *  endpoint, SigV4-signed (adapter_config.region required). */
export const BEDROCK: ChatAdapter = {
	family: "bedrock",
	dialect: "openai",
	caps: OPENAI_COMPAT.caps,
	parseResponse: OPENAI_COMPAT.parseResponse,
	usageOf: OPENAI_COMPAT.usageOf,
	normalizeError: (status, wire, headers) =>
		normalizeUpstreamError("bedrock", status, wire, headers),
	buildCall: bedrockBuildCall,
};
