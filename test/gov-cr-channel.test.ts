// test/gov-cr-channel.test.ts — W160 hub change-request channel, originate
// side: admin declare + list (buckle:admin only), origin recording, the
// structural private-domain guard, probe-gated applied→verified, lifecycle
// enforcement (no skipping; failed-from-live + escalation note).

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { declareCR, transitionCR } from "../src/gov/federation-manifest.ts";
import { startServer } from "../src/server.ts";

const ROOT = "buckle-test-root";

/** Hub with a versioned policy surface (the verification probe re-reads
 *  this file at verify time) + a spoke-private group that must never leak. */
async function startFed(): Promise<{
	base: string;
	govDb: Database;
	stop: () => void;
}> {
	const dir = `/tmp/w160-cr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const policy = [
		"version: 1",
		"gateway:",
		"  num_retries: 1",
		"  allowed_fails: 3",
		"  cooldown_time: 30",
		"  fallbacks:",
		"    glm-5.3-flash: [local-swarm, gpt-5.2]",
		"tags:",
		"  glm-5.3-flash: [fast, cheap, general]",
		"",
	].join("\n");
	const upstreams = [
		"version: 1",
		"groups:",
		"  glm-5.3-flash:",
		"    - url: http://127.0.0.1:8501",
		"      dialect: openai",
		"  local-swarm:",
		"    - url: http://127.0.0.1:8502",
		"      dialect: openai",
		"      visibility: spoke-private",
		"",
	].join("\n");
	await Bun.write(`${dir}.policy.yaml`, policy);
	await Bun.write(`${dir}.upstreams.yaml`, upstreams);
	const srv = startServer({
		port: 0,
		policyPath: `${dir}.policy.yaml`,
		upstreamsPath: `${dir}.upstreams.yaml`,
		dbPath: ":memory:",
		auth: { rootKey: ROOT },
	});
	const fedDb = srv.gov.federation?.db;
	if (fedDb === undefined) throw new Error("federation surface missing on gov");
	return {
		base: `http://127.0.0.1:${srv.port}`,
		govDb: fedDb,
		stop: () => srv.stop(true),
	};
}

async function issueKey(
	base: string,
	body: Record<string, unknown>,
): Promise<string> {
	const res = await fetch(`${base}/v1/admin/keys`, {
		method: "POST",
		headers: { authorization: `Bearer ${ROOT}` },
		body: JSON.stringify(body),
	});
	const out = (await res.json()) as { key: string };
	return out.key;
}

function declareReq(
	base: string,
	key: string,
	body: Record<string, unknown>,
): Promise<Response> {
	return fetch(`${base}/federation/cr`, {
		method: "POST",
		headers: { authorization: `Bearer ${key}` },
		body: JSON.stringify(body),
	});
}

interface CrRowView {
	id: string;
	action: string;
	target: string;
	declared_at: string;
	state: string;
	payload: unknown;
	origin: { system?: string; actor?: string } | null;
	verified_at: number | null;
	claimed_by: string | null;
}

async function manifestCRs(base: string, key: string): Promise<CrRowView[]> {
	const res = await fetch(`${base}/federation/policy-manifest`, {
		headers: { authorization: `Bearer ${key}` },
	});
	const body = (await res.json()) as { cr_queue: CrRowView[] };
	return body.cr_queue;
}

describe("w160: full lifecycle", () => {
	test("declare→manifest→delivered→applied→verified(probe-gated)→reported-up", async () => {
		const fed = await startFed();
		const res = await declareReq(fed.base, ROOT, {
			id: "cr-life",
			action: "adopt-policy",
			target: "policy@1",
			payload: { revision: 1 },
			origin: { system: "belt", actor: "kkh" },
		});
		expect(res.status).toBe(201);
		const spokeKey = await issueKey(fed.base, {
			name: "spoke-w",
			scopes: ["buckle:spoke:WRITE_"],
		});
		const post = (state: string) =>
			fetch(`${fed.base}/federation/cr/cr-life/status`, {
				method: "POST",
				headers: { authorization: `Bearer ${spokeKey}` },
				body: JSON.stringify({ state }),
			});
		expect((await post("delivered")).status).toBe(200);
		expect((await post("applied")).status).toBe(200);
		const v = await post("verified");
		expect(v.status).toBe(200);
		expect((await post("reported-up")).status).toBe(200);
		const row = (await manifestCRs(fed.base, ROOT)).find(
			(c) => c.id === "cr-life",
		);
		expect(row?.state).toBe("reported-up");
		expect(row?.verified_at).not.toBeNull();
		fed.stop();
	});

	test("verified is probe-gated: policy@99 fails the hub re-read, CR stays applied", async () => {
		const fed = await startFed();
		await declareReq(fed.base, ROOT, {
			id: "cr-probe-fail",
			action: "adopt-policy",
			target: "policy@99",
			origin: { system: "belt", actor: "kkh" },
		});
		const spokeKey = await issueKey(fed.base, {
			name: "spoke-w2",
			scopes: ["buckle:spoke:WRITE_"],
		});
		const post = (state: string) =>
			fetch(`${fed.base}/federation/cr/cr-probe-fail/status`, {
				method: "POST",
				headers: { authorization: `Bearer ${spokeKey}` },
				body: JSON.stringify({ state }),
			});
		await post("delivered");
		await post("applied");
		const v = await post("verified");
		expect(v.status).toBe(409);
		const why = (await v.json()) as { error: { code: string } };
		expect(why.error.code).toBe("buckle.cr_probe");
		const row = (await manifestCRs(fed.base, ROOT)).find(
			(c) => c.id === "cr-probe-fail",
		);
		expect(row?.state).toBe("applied");
		fed.stop();
	});
});

describe("w160: domain separation — hub-admin only, private content never enters", () => {
	test("spoke:WRITE_ CANNOT declare (403 admin capability); spoke cannot list; anon 401", async () => {
		const fed = await startFed();
		const spokeKey = await issueKey(fed.base, {
			name: "spoke-only",
			scopes: ["buckle:spoke:WRITE_"],
		});
		const deny = await declareReq(fed.base, spokeKey, {
			id: "cr-nope",
			action: "adopt-policy",
			target: "policy@1",
			origin: { system: "belt", actor: "x" },
		});
		expect(deny.status).toBe(403);
		const err = (await deny.json()) as { why: string };
		expect(err.why).toContain("buckle:admin:WRITE_");
		const list = await fetch(`${fed.base}/federation/cr`, {
			headers: { authorization: `Bearer ${spokeKey}` },
		});
		expect(list.status).toBe(403);
		const anon = await declareReq(fed.base, "bksk_anon", {
			id: "cr-anon",
			action: "a",
			target: "t",
			origin: { system: "s", actor: "a" },
		});
		expect(anon.status).toBe(401);
		fed.stop();
	});

	test("payload marked/derived data_domain=private → 422 buckle.cr_private_domain; queue untouched", async () => {
		const fed = await startFed();
		const marked = await declareReq(fed.base, ROOT, {
			id: "cr-private-1",
			action: "adopt-policy",
			target: "policy@1",
			payload: { data_domain: "private", rules: ["x"] },
			origin: { system: "belt", actor: "kkh" },
		});
		expect(marked.status).toBe(422);
		const nested = await declareReq(fed.base, ROOT, {
			id: "cr-private-2",
			action: "adopt-policy",
			target: "policy@1",
			payload: { rules: [{ id: "r", data_domain: "private" }] },
			origin: { system: "belt", actor: "kkh" },
		});
		expect(nested.status).toBe(422);
		const viaOrigin = await declareReq(fed.base, ROOT, {
			id: "cr-private-3",
			action: "adopt-policy",
			target: "policy@1",
			origin: { system: "belt", actor: "kkh", data_domain: "private" },
		});
		expect(viaOrigin.status).toBe(422);
		const crs = await manifestCRs(fed.base, ROOT);
		expect(crs.length).toBe(0);
		fed.stop();
	});
});

describe("w160: seam — declareCR guard + lifecycle edges", () => {
	test("seam: private-marker payload rejected before any row; idempotent on id", () => {
		const srv = startServer({
			port: 0,
			policyPath: "/tmp/w160-seam.policy.yaml",
			dbPath: ":memory:",
		});
		const db = srv.gov.federation?.db;
		if (db === undefined) throw new Error("federation missing");
		const bad = declareCR(db, {
			id: "s1",
			action: "a",
			target: "t",
			origin: { system: "s", actor: "a", data_domain: "private" } as never,
		});
		expect(bad.ok).toBe(false);
		const made = declareCR(db, {
			id: "s2",
			action: "a",
			target: "t",
			origin: { system: "suspenders", actor: "w" },
		});
		expect(made.ok && made.row.state).toBe("declared");
		srv.stop(true);
	});

	test("transitionCR: no-skip, failed-from-live + note, terminal states close", () => {
		const srv = startServer({
			port: 0,
			policyPath: "/tmp/w160-seam2.policy.yaml",
			dbPath: ":memory:",
		});
		const db = srv.gov.federation?.db;
		if (db === undefined) throw new Error("federation missing");
		const made = declareCR(db, {
			id: "s10",
			action: "adopt-policy",
			target: "work-graph@1",
			origin: { system: "suspenders", actor: "w160" },
		});
		if (!made.ok) throw new Error("declare failed");
		expect(transitionCR(db, "s10", "applied", null).ok).toBe(false);
		const fail = transitionCR(db, "s10", "failed", "spoke cannot reconcile");
		expect(fail.ok && fail.row.state).toBe("failed");
		expect(fail.ok && fail.row.note).toContain("reconcile");
		const term = transitionCR(db, "s10", "reported-up", null);
		expect(term.ok).toBe(false);
		srv.stop(true);
	});
});

describe("w193: CR claim binding (buckle.cr_claimed)", () => {
	test("first spoke report claims; different spoke 403; admin bypass", async () => {
		const fed = await startFed();
		await declareReq(fed.base, ROOT, {
			id: "cr-claim",
			action: "adopt-policy",
			target: "policy@1",
			origin: { system: "belt", actor: "kkh" },
		});
		const keyIdOf = (raw: string): string =>
			new Bun.CryptoHasher("sha256").update(raw).digest("hex").slice(0, 12);
		const ka = await issueKey(fed.base, {
			name: "spoke-a",
			scopes: ["buckle:spoke:WRITE_"],
		});
		const kb = await issueKey(fed.base, {
			name: "spoke-b",
			scopes: ["buckle:spoke:WRITE_"],
		});
		const post = (key: string, state: string) =>
			fetch(`${fed.base}/federation/cr/cr-claim/status`, {
				method: "POST",
				headers: { authorization: `Bearer ${key}` },
				body: JSON.stringify({ state }),
			});
		const d = await post(ka, "delivered");
		expect(d.status).toBe(200);
		const row = (await manifestCRs(fed.base, ROOT)).find(
			(c) => c.id === "cr-claim",
		);
		expect(row?.state).toBe("delivered");
		expect(row?.claimed_by).toBe(keyIdOf(ka));
		const other = await post(kb, "applied");
		expect(other.status).toBe(403);
		const why = (await other.json()) as { error: { code: string } };
		expect(why.error.code).toBe("buckle.cr_claimed");
		const admin = await post(ROOT, "applied");
		expect(admin.status).toBe(200);
		expect(row?.claimed_by).toBe(keyIdOf(ka));
		fed.stop();
	});

	test("seam: transitionCR claim semantics (bind, refuse, admin)", () => {
		const srv = startServer({
			port: 0,
			policyPath: "/tmp/w193-seam.policy.yaml",
			dbPath: ":memory:",
		});
		const db = srv.gov.federation?.db;
		if (db === undefined) throw new Error("federation missing");
		const made = declareCR(db, {
			id: "s193",
			action: "adopt-policy",
			target: "work-graph@2",
			origin: { system: "suspenders", actor: "w193" },
		});
		if (!made.ok) throw new Error("declare failed");
		const first = transitionCR(db, "s193", "delivered", null, undefined, {
			id: "spoke-1",
			admin: false,
		});
		expect(first.ok).toBe(true);
		if (first.ok) expect(first.row.claimed_by).toBe("spoke-1");
		const other = transitionCR(db, "s193", "applied", null, undefined, {
			id: "spoke-2",
			admin: false,
		});
		expect(other.ok).toBe(false);
		if (!other.ok) expect(other.code).toBe("buckle.cr_claimed");
		const adm = transitionCR(db, "s193", "applied", null, undefined, {
			id: "hub-admin",
			admin: true,
		});
		expect(adm.ok).toBe(true);
		srv.stop(true);
	});
});
