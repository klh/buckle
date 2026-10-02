// src/gov/federation-signing.ts — W193 manifest signatures. The hub signs
// the policy manifest with an RS256 key that NEVER leaves BUCKLE_SECRETS_HOME
// (owner law: signing keys are hub-only, federation doc §identity plane).
// Spokes fetch the public half from /.well-known/jwks.json and verify the
// detached JWS over the exact response bytes — authenticity never rests on
// transport auth. Wire form: compact JWS, detached payload —
//   <b64url(protected)>..<b64url(signature)>
// with the signing input <b64url(protected)>.<b64url(exact body bytes)>.
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	createSign,
	createVerify,
	generateKeyPairSync,
	type KeyObject,
} from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface PublicJwk {
	kty: string;
	n: string;
	e: string;
	kid: string;
	use: string;
	alg: string;
}

export interface JwksDoc {
	keys: PublicJwk[];
}

interface StoredKey {
	kid: string;
	created_at: string;
	private_jwk: Record<string, string>;
}

const KEY_FILE = "buckle-federation-signing.json";

function b64url(input: Uint8Array | string): string {
	const bytes =
		typeof input === "string" ? new TextEncoder().encode(input) : input;
	return Buffer.from(bytes).toString("base64url");
}

/** sha-256 hex of the modulus bytes — the stable key id (survives restarts;
 *  derives from key material, never from time or hostname). */
function kidOf(pub: Record<string, string>): string {
	const n = Buffer.from(pub.n, "base64");
	return `bkfed-${createHash("sha256").update(n).digest("hex").slice(0, 12)}`;
}

/** W193: spoke-side parity — verify a detached JWS over the exact body
 *  bytes against a JWKS doc. Spokes and the sim smoke import this; the
 *  buckle test suite uses it for the end-to-end check. */
export async function verifyJwsDetached(
	body: Uint8Array,
	jws: string,
	jwks: JwksDoc,
): Promise<{ ok: boolean; why: string | null }> {
	const [h, p, s] = jws.split(".");
	if (p !== "" || h === undefined || s === undefined)
		return { ok: false, why: "malformed JWS (want compact, detached)" };
	const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as {
		alg?: string;
		kid?: string;
	};
	if (header.alg !== "RS256")
		return { ok: false, why: `alg ${String(header.alg)} refused` };
	const key = jwks.keys.find((k) => k.kid === header.kid);
	if (key === undefined)
		return { ok: false, why: `no JWKS key for kid ${String(header.kid)}` };
	const input = `${h}.${Buffer.from(body).toString("base64url")}`;
	const good = createVerify("RSA-SHA256")
		.update(input)
		.verify(
			createPublicKey({ key: key as never, format: "jwk" }),
			Buffer.from(s, "base64url"),
		);
	return good
		? { ok: true, why: null }
		: { ok: false, why: "signature mismatch" };
}

/** One RS256 manifest-signing identity: load-or-generate in the hub secrets
 *  home, expose JWKS + detached-JWS sign/verify. */
export class ManifestSigner {
	readonly kid: string;
	private readonly priv: KeyObject;
	private readonly pubJwk: Record<string, string>;

	private constructor(
		priv: KeyObject,
		pubJwk: Record<string, string>,
		kid: string,
	) {
		this.priv = priv;
		this.pubJwk = pubJwk;
		this.kid = kid;
	}

	/** Load the persisted identity, or generate + persist one (chmod 600 —
	 *  the file never leaves the secrets home). */
	static create(home: string): ManifestSigner {
		mkdirSync(home, { recursive: true });
		const path = join(home, KEY_FILE);
		if (existsSync(path)) {
			const stored = JSON.parse(readFileSync(path, "utf8")) as StoredKey;
			return new ManifestSigner(
				createPrivateKey({ key: stored.private_jwk, format: "jwk" }),
				stored.private_jwk,
				stored.kid,
			);
		}
		const { publicKey, privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			publicKeyEncoding: { type: "spki", format: "jwk" },
			privateKeyEncoding: { type: "pkcs8", format: "jwk" },
		});
		const kid = kidOf(publicKey);
		const stored: StoredKey = {
			kid,
			created_at: new Date().toISOString(),
			private_jwk: privateKey,
		};
		writeFileSync(path, JSON.stringify(stored), { mode: 0o600 });
		chmodSync(path, 0o600);
		return new ManifestSigner(
			createPrivateKey({ key: privateKey, format: "jwk" }),
			privateKey,
			kid,
		);
	}

	/** The public half a spoke may hold: JWKS with kid + use=sig (the sim
	 *  smoke contract). */
	jwks(): JwksDoc {
		return {
			keys: [
				{
					kty: "RSA",
					n: this.pubJwk.n,
					e: this.pubJwk.e,
					kid: this.kid,
					use: "sig",
					alg: "RS256",
				},
			],
		};
	}

	/** Detached compact JWS over the exact body bytes. */
	sign(body: Uint8Array): string {
		const protectedB64 = b64url(
			JSON.stringify({ alg: "RS256", typ: "JWS", kid: this.kid }),
		);
		const input = `${protectedB64}.${b64url(body)}`;
		const sig = createSign("RSA-SHA256").update(input).sign(this.priv);
		return `${protectedB64}..${Buffer.from(sig).toString("base64url")}`;
	}

	/** Verify a detached JWS against the exact body bytes (audit/test side;
	 *  spokes verify via their own JWKS fetch). RS256 demanded. */
	verify(body: Uint8Array, jws: string): boolean {
		const [h, p, s] = jws.split(".");
		if (p !== "" || h === undefined || s === undefined) return false;
		const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as {
			alg?: string;
			kid?: string;
		};
		if (header.alg !== "RS256") return false;
		const key = createPublicKey({ key: this.pubJwk, format: "jwk" });
		const input = `${h}.${b64url(body)}`;
		return createVerify("RSA-SHA256")
			.update(input)
			.verify(key, Buffer.from(s, "base64url"));
	}
}
