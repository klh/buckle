// test/gov-hardening.test.ts — review #13 §1.3: attacker-controlled JWS
// headers never throw (refusal, not a crash path); root-key compare is
// constant-time over the digests.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ManifestSigner,
	parseJwsHeader,
	verifyJwsDetached,
} from "../src/gov/federation-signing.ts";
import { hashKey } from "../src/gov/keys.ts";
import { rootMatches } from "../src/gov/middleware.ts";

const b64 = (s: string): string => Buffer.from(s).toString("base64url");
const body = new TextEncoder().encode('{"m":1}');

describe("JWS header guard", () => {
	const signer = ManifestSigner.create(
		mkdtempSync(join(tmpdir(), "gov-hardening-")),
	);
	const jwks = signer.jwks();
	const bad = [
		`${b64("{not json")}..sig`,
		`${b64("null")}..sig`,
		`${b64("[1,2]")}..sig`,
		"!!!..sig",
	];

	test("verifyJwsDetached refuses malformed headers without throwing", async () => {
		for (const jws of bad) {
			const r = await verifyJwsDetached(body, jws, jwks);
			expect(r.ok).toBe(false);
		}
		const r = await verifyJwsDetached(body, bad[0] as string, jwks);
		expect(r.why).toBe("malformed JWS header");
	});

	test("ManifestSigner.verify refuses malformed headers without throwing", () => {
		for (const jws of bad) expect(signer.verify(body, jws)).toBe(false);
		expect(signer.verify(body, signer.sign(body))).toBe(true);
	});

	test("unusable JWKS key material is a refusal, not a throw", async () => {
		const jws = signer.sign(body);
		const broken = {
			keys: [{ ...jwks.keys[0], n: "AA", e: "" } as never],
		};
		const r = await verifyJwsDetached(body, jws, broken);
		expect(r.ok).toBe(false);
	});

	test("parseJwsHeader: objects only", () => {
		expect(parseJwsHeader(b64('{"alg":"RS256"}'))?.alg).toBe("RS256");
		expect(parseJwsHeader(b64('"str"'))).toBeNull();
	});
});

describe("root key compare", () => {
	test("timing-safe match / mismatch", () => {
		const h = hashKey("root-secret");
		expect(rootMatches("root-secret", h)).toBe(true);
		expect(rootMatches("root-secreT", h)).toBe(false);
		expect(rootMatches("", h)).toBe(false);
		expect(rootMatches("root-secret", "short")).toBe(false);
	});
});
