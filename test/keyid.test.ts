// test/keyid.test.ts — bearer token → hashed ledger key id.
import { expect, test } from "bun:test";
import { keyIdFromAuth } from "../src/ledger.ts";

test("keyIdFromAuth: bearer → stable truncated sha-256, never the token", () => {
	const id1 = keyIdFromAuth("Bearer sekrit-token");
	expect(keyIdFromAuth("Bearer sekrit-token")).toBe(id1);
	expect(id1).toHaveLength(12);
	expect(id1).not.toContain("sekrit");
});

test("keyIdFromAuth: no authorization header → empty key id", () => {
	expect(keyIdFromAuth(null)).toBe("");
	expect(keyIdFromAuth("Basic abc")).toBe("");
});
