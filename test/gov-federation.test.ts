// test/gov-federation.test.ts — W154 federation surfaces e2e: anonymous
// spoke-pull GETs (manifest + entitlements), credential validation (presented
// creds never downgraded), spoke-class scopes, team ceilings, CR lifecycle
// transitions enforced server-side, visibility-law exclusion.
// W193: pulls are authenticated (spoke:READ_) and the manifest is signed.
import { describe, expect, test } from "bun:test";
import { declareCR } from "../src/gov/federation-manifest.ts";
import { startServer } from "../src/server.ts";

const ROOT = "buckle-test-root";

/** Hub with a scratch pool: one live loopback group, one dormant cloud tier,
 *  one spoke-private group that must never leak into entitlements. */
async function startFed(): Promise<{
	base: string;
	srv: ReturnType<typeof startServer>;
	stop: () => void;
}> {
	const dir = `/tmp/w154-fed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
		"  local-swarm: [local, general]",
		"  gpt-5.2: [frontier]",
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
		"  gpt-5.2: []",
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
	return {
		base: `http://127.0.0.1:${srv.port}`,
		srv,
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

describe("federation: policy manifest (anonymous spoke-pull)", () => {
	test("GET /federation/policy-manifest → 200 {version, rules[], cr_queue[]}", async () => {
		const fed = await startFed();
		const spokeKey = await issueKey(fed.base, {
			name: "spoke-pull",
			scopes: ["buckle:spoke:READ_"],
		});
		const res = await fetch(`${fed.base}/federation/policy-manifest`, {
			headers: { authorization: `Bearer ${spokeKey}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			version: string;
			rules: Array<{ id: string }>;
			cr_queue: unknown[];
		};
		expect(body.version.startsWith("fed-")).toBe(true);
		expect(body.rules.length).toBeGreaterThan(0);
		const ids = body.rules.map((r) => r.id);
		expect(ids).toContain("gateway.knobs");
		expect(ids).toContain("ladder.glm-5.3-flash");
		expect(ids).toContain("tags.glm-5.3-flash");
		expect(Array.isArray(body.cr_queue)).toBe(true);
		fed.stop();
	});
});

describe("federation: entitlements (echo menu, visibility law)", () => {
	test("hub models only — spoke-private excluded, dormant = cloud", async () => {
		const fed = await startFed();
		const spokeKey = await issueKey(fed.base, {
			name: "spoke-menu",
			scopes: ["buckle:spoke:READ_"],
		});
		const res = await fetch(`${fed.base}/federation/entitlements`, {
			headers: { authorization: `Bearer ${spokeKey}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			models: Array<{
				id: string;
				tier: string;
				locality: string;
				available: boolean;
				family: string | null;
			}>;
			ceilings: unknown;
		};
		const ids = body.models.map((m) => m.id);
		expect(ids).toContain("glm-5.3-flash");
		expect(ids).toContain("gpt-5.2");
		expect(ids).not.toContain("local-swarm");
		const glm = body.models.find((m) => m.id === "glm-5.3-flash");
		expect(glm?.locality).toBe("hub-local");
		expect(glm?.available).toBe(true);
		expect(glm?.family).toBe("openai-compat");
		const gpt = body.models.find((m) => m.id === "gpt-5.2");
		expect(gpt?.tier).toBe("frontier");
		expect(gpt?.locality).toBe("cloud");
		expect(gpt?.available).toBe(false);
		expect(body.ceilings).toBeNull();
		fed.stop();
	});

	test("presented credentials are validated — bad bearer is 401, never anonymous", async () => {
		const fed = await startFed();
		const res = await fetch(`${fed.base}/federation/entitlements`, {
			headers: { authorization: "Bearer bksk_nope" },
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("buckle.invalid_key");
		fed.stop();
	});
});

describe("federation: spoke-class scopes + team ceilings", () => {
	test("team key → entitlements carry ceilings", async () => {
		const fed = await startFed();
		await fetch(`${fed.base}/v1/admin/teams`, {
			method: "POST",
			headers: { authorization: `Bearer ${ROOT}` },
			body: JSON.stringify({
				team_id: "ops",
				rpm_ceiling: 100,
				tpm_ceiling: 5000,
			}),
		});
		const spokeKey = await issueKey(fed.base, {
			name: "spoke-1",
			team: "ops",
			scopes: ["buckle:spoke:READ_"],
		});
		const res = await fetch(`${fed.base}/federation/entitlements`, {
			headers: { authorization: `Bearer ${spokeKey}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ceilings: { rpm: number | null; tpm: number | null } | null;
		};
		expect(body.ceilings).toEqual({ rpm: 100, tpm: 5000 });
		fed.stop();
	});

	test("proxy-class key → 403 insufficient_scope on federation GET", async () => {
		const fed = await startFed();
		const proxyKey = await issueKey(fed.base, {
			name: "proxy-1",
			scopes: ["buckle:proxy:WRITE_"],
		});
		const res = await fetch(`${fed.base}/federation/entitlements`, {
			headers: { authorization: `Bearer ${proxyKey}` },
		});
		expect(res.status).toBe(403);
		fed.stop();
	});
});

interface CrEntry {
	id: string;
	action: string;
	state: string;
	declared_at: string;
}

describe("federation: CR lifecycle (server-side transitions)", () => {
	test("declared CR rides the manifest; POST requires spoke auth", async () => {
		const fed = await startFed();
		const fedDb = fed.srv.gov.federation?.db;
		if (fedDb === undefined)
			throw new Error("federation surface missing on gov");
		declareCR(fedDb, {
			id: "cr-1",
			action: "adopt-policy",
			target: "routing-policy@1",
			origin: { system: "belt", actor: "w154-test" },
		});
		const spokeKey = await issueKey(fed.base, {
			name: "spoke-cr",
			scopes: ["buckle:spoke:READ_"],
		});
		const res = await fetch(`${fed.base}/federation/policy-manifest`, {
			headers: { authorization: `Bearer ${spokeKey}` },
		});
		const body = (await res.json()) as { cr_queue: CrEntry[] };
		expect(body.cr_queue).toHaveLength(1);
		expect(body.cr_queue[0]?.id).toBe("cr-1");
		expect(body.cr_queue[0]?.state).toBe("declared");
		const anon = await fetch(`${fed.base}/federation/cr/cr-1/status`, {
			method: "POST",
			body: JSON.stringify({ state: "delivered" }),
		});
		expect(anon.status).toBe(401);
		fed.stop();
	});

	test("spoke:WRITE_ key walks declared→delivered; 409 on illegal; 404 unknown", async () => {
		const fed = await startFed();
		const fedDb = fed.srv.gov.federation?.db;
		if (fedDb === undefined)
			throw new Error("federation surface missing on gov");
		declareCR(fedDb, {
			id: "cr-2",
			action: "adopt-policy",
			target: "policy@2",
			origin: { system: "belt", actor: "w154-test" },
		});
		const key = await issueKey(fed.base, {
			name: "spoke-w",
			scopes: ["buckle:spoke:WRITE_"],
		});
		const post = (state: string, id: string) =>
			fetch(`${fed.base}/federation/cr/${id}/status`, {
				method: "POST",
				headers: { authorization: `Bearer ${key}` },
				body: JSON.stringify({ state }),
			});
		const d = await post("delivered", "cr-2");
		expect(d.status).toBe(200);
		const dBody = (await d.json()) as { state: string };
		expect(dBody.state).toBe("delivered");
		const again = await post("delivered", "cr-2");
		expect(again.status).toBe(409);
		const missing = await post("delivered", "no-such-cr");
		expect(missing.status).toBe(404);
		fed.stop();
	});
});
