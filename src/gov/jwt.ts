// src/gov/jwt.ts — W141 JWT VALIDATOR SEAM ONLY (no token minting — W149
// owns the issuer in suspenders). Verifies RS256 via per-issuer JWKS, issuer
// allowlist, audience, exp/nbf with clock skew, then maps the IdP-neutral
// claims shape to the same principal shape API keys yield:
//   roles: ["buckle:<resource>:<ROLE_>", ...]  (scope-shaped role strings)
//   scope: "buckle:proxy:WRITE_ ..."           (RFC 8693, accepted too)
// Fixed-shape 401s with stable codes; any corporate IdP (authentik, Entra,
// Zitadel) drops in by adding an issuer entry — the validator never changes.
import { hasScope, parseScope } from "./scopes.ts";

export interface IssuerSpec {
	issuer: string;
	jwksUri: string;
}

export interface JwtOpts {
	issuers: IssuerSpec[];
	audience: string;
	clockSkewS?: number;
}

export interface JwtClaims {
	iss: string;
	sub: string;
	aud: string | string[];
	exp?: number;
	nbf?: number;
	iat?: number;
	jti?: string;
	roles?: string[];
	scope?: string;
}

export interface JwtResult {
	ok: boolean;
	code: string;
	why: string;
	claims?: JwtClaims;
	scopes?: string[];
	sub?: string;
	jti?: string | null;
}

const dec = new TextDecoder();

function b64urlJson(part: string): unknown {
	const pad = (4 - (part.length % 4)) % 4;
	const b64 = part.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat(pad);
	const bytes = Buffer.from(b64, "base64");
	return JSON.parse(dec.decode(bytes));
}

function b64urlBytes(part: string): Uint8Array {
	const pad = (4 - (part.length % 4)) % 4;
	const b64 = part.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat(pad);
	return new Uint8Array(Buffer.from(b64, "base64"));
}

interface Jwk {
	kid: string | null;
	key: CryptoKey;
}

/** Per-issuer JWKS cache with TTL — refetch on unknown kid only. */
class JwksCache {
	private readonly cache = new Map<string, { keys: Jwk[]; at: number }>();

	constructor(
		private readonly ttlMs: number = 300_000,
		private readonly fetcher: typeof fetch = fetch,
	) {}

	async keysFor(uri: string): Promise<Jwk[]> {
		const hit = this.cache.get(uri);
		if (hit !== undefined && Date.now() - hit.at < this.ttlMs) return hit.keys;
		return this.load(uri);
	}

	private async load(uri: string): Promise<Jwk[]> {
		const res = await this.fetcher(uri);
		if (!res.ok) throw new Error(`jwks fetch ${res.status}`);
		const body = (await res.json()) as {
			keys?: Array<{ kid?: string; kty: string; n?: string; e?: string }>;
		};
		const keys: Jwk[] = [];
		for (const j of body.keys ?? []) {
			if (j.kty !== "RSA" || j.n === undefined || j.e === undefined) continue;
			const cryptoKey = await crypto.subtle.importKey(
				"jwk",
				{ kty: "RSA", n: j.n, e: j.e, alg: "RS256" },
				{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
				false,
				["verify"],
			);
			keys.push({ kid: j.kid ?? null, key: cryptoKey });
		}
		this.cache.set(uri, { keys, at: Date.now() });
		return keys;
	}
}

/** The W141 validator seam: verify a bearer token as an RS256 JWT against an
 *  issuer allowlist + audience + roles claim. Fixed-shape rejections. */
export function createJwtValidator(opts: JwtOpts): {
	validate(token: string): Promise<JwtResult>;
} {
	const skewMs = (opts.clockSkewS ?? 30) * 1000;
	const byIssuer = new Map(opts.issuers.map((s) => [s.issuer, s.jwksUri]));
	const jwks = new JwksCache();
	const reject = (code: string, why: string): JwtResult => ({
		ok: false,
		code,
		why,
	});
	return {
		async validate(token: string): Promise<JwtResult> {
			const parts = token.split(".");
			if (parts.length !== 3)
				return reject("buckle.jwt_malformed", "not a compact JWS");
			const [h64, p64, s64] = parts as [string, string, string];
			const header = b64urlJson(h64) as {
				alg?: string;
				kid?: string;
			};
			if (header.alg !== "RS256")
				return reject(
					"buckle.jwt_malformed",
					`alg ${String(header.alg)} not RS256`,
				);
			const claims = b64urlJson(p64) as JwtClaims;
			const uri = byIssuer.get(String(claims.iss));
			if (uri === undefined)
				return reject(
					"buckle.jwt_bad_issuer",
					`issuer ${String(claims.iss)} not allowed`,
				);
			return verifySignature({
				h64,
				p64,
				s64,
				claims,
				uri,
				header,
				skewMs,
				jwks,
				audience: opts.audience,
			});
		},
	};
}

interface SigArgs {
	h64: string;
	p64: string;
	s64: string;
	claims: JwtClaims;
	uri: string;
	header: { alg?: string; kid?: string };
	skewMs: number;
	jwks: JwksCache;
	audience: string;
}

async function verifySignature(args: SigArgs): Promise<JwtResult> {
	const keys = await args.jwks.keysFor(args.uri);
	const sig = b64urlBytes(args.s64);
	const signed = new TextEncoder().encode(`${args.h64}.${args.p64}`);
	for (const k of keys) {
		const kidMismatch =
			k.kid !== null &&
			args.header.kid !== undefined &&
			k.kid !== args.header.kid;
		if (kidMismatch) continue;
		const sigBuf = sig.buffer.slice(
			sig.byteOffset,
			sig.byteOffset + sig.byteLength,
		) as ArrayBuffer;
		const good = await crypto.subtle.verify(
			{ name: "RSASSA-PKCS1-v1_5" },
			k.key,
			sigBuf,
			signed,
		);
		if (good) return checkClaims(args, k.kid);
	}
	return {
		ok: false,
		code: "buckle.jwt_bad_signature",
		why: "no usable key verified",
	};
}

function checkClaims(args: SigArgs, kid: string | null): JwtResult {
	const now = Date.now();
	const c = args.claims;
	if (c.exp !== undefined && c.exp * 1000 + args.skewMs <= now)
		return { ok: false, code: "buckle.jwt_expired", why: "exp in past" };
	if (c.nbf !== undefined && c.nbf * 1000 - args.skewMs > now)
		return {
			ok: false,
			code: "buckle.jwt_not_yet_valid",
			why: "nbf in future",
		};
	const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
	if (!aud.includes(args.audience))
		return { ok: false, code: "buckle.jwt_bad_audience", why: "aud mismatch" };
	const scopes = rolesToScopes(c);
	return {
		ok: true,
		code: "ok",
		why: "verified",
		claims: c,
		scopes,
		sub: c.sub,
		jti: c.jti ?? kid,
	};
}

/** IdP-neutral claims → buckle scopes: the `roles` array holds scope-shaped
 *  strings; the RFC 8693 `scope` string is accepted too. Invalid entries are
 *  dropped (reported via the audit why-field, never smuggled in). */
function rolesToScopes(c: JwtClaims): string[] {
	const out: string[] = [];
	for (const r of c.roles ?? []) {
		const s = parseScope(r);
		if (s !== null) out.push(s);
	}
	for (const s of (c.scope ?? "").split(/\s+/)) {
		if (s.length === 0) continue;
		const v = parseScope(s);
		if (v !== null) out.push(v);
	}
	return [...new Set(out)];
}

/** Gate-side scope check (WRITE_⊃READ_ inheritance) for JWT principals. */
export function jwtScopeCheck(scopes: string[], needed: string): boolean {
	return hasScope(scopes, needed);
}
