// test/repo-policy.test.ts — W7 repo-policy gate: condition grammar, row
// runner semantics (silent when satisfied, one missing-question per gap,
// honest skips), the loader chain, the committed rows against this repo,
// the /repo-policy/check route, and the LOCAL-ONLY fact resolver.
import { describe, expect, test } from "bun:test";
import {
	loadRepoPolicies,
	resolvePolicySource,
	runRepoPolicies,
	type Condition,
	type RepoPolicyRow,
} from "../src/repo-policy.ts";
import {
	repoPolicyRoutes,
	type RepoPolicyDeps,
} from "../src/repo-policy-routes.ts";
import type { Servicemon } from "../src/servicemon.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── fixtures ──
let n = 0;
const fixture = (files: Record<string, string>): string => {
	const dir = mkdtempSync(join(tmpdir(), `rp-${++n}-`));
	for (const [name, contents] of Object.entries(files)) {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), contents);
	}
	return dir;
};
const cleanup = (dir: string): void =>
	rmSync(dir, { recursive: true, force: true });

const row = (over: Partial<RepoPolicyRow>): RepoPolicyRow => ({
	id: "t-row",
	repoClass: "any",
	check: [{ exists: "LICENSE" }],
	missingQuestion: "where is the LICENSE?",
	policySource: "commit",
	...over,
});

// A no-op metering sink (meter() is fire-and-forget in tests).
const sm = (): Servicemon =>
	({ counter: () => ({ inc: () => {} }) }) as unknown as Servicemon;

const deps = (rows: RepoPolicyRow[]): RepoPolicyDeps => ({ rows, sm: sm() });

describe("condition grammar", () => {
	test("exists / existsAny", async () => {
		const dir = fixture({ LICENSE: "MIT" });
		const ok = await runRepoPolicies(dir, { rows: [row({})] });
		expect(ok.gaps).toEqual([]);
		const miss = await runRepoPolicies(dir, {
			rows: [row({ check: [{ exists: "NOPE" }] })],
		});
		expect(miss.gaps).toHaveLength(1);
		const any = await runRepoPolicies(dir, {
			rows: [row({ check: [{ existsAny: ["NOPE", "LICENSE"] }] })],
		});
		expect(any.satisfied).toEqual(["t-row"]);
		cleanup(dir);
	});
	test("grep hit, grep miss = gap, unreadable = honest skip", async () => {
		const dir = fixture({
			"src/server.ts":
				'Bun.serve({ fetch: () => new Response("ok /health") });',
			"src/other.ts": "nothing here",
		});
		const ok = await runRepoPolicies(dir, {
			rows: [row({ check: [{ grep: "src/server.ts", pattern: "/health" }] })],
		});
		expect(ok.gaps).toEqual([]);
		const miss = await runRepoPolicies(dir, {
			rows: [row({ check: [{ grep: "src/other.ts", pattern: "/health" }] })],
		});
		expect(miss.gaps).toHaveLength(1);
		const skip = await runRepoPolicies(dir, {
			rows: [row({ check: [{ grep: "absent.ts", pattern: "x" }] })],
		});
		expect(skip.gaps).toEqual([]);
		expect(skip.skips).toEqual([
			{ id: "t-row", repoClass: "any", reason: "unreadable: absent.ts" },
		]);
		cleanup(dir);
	});
	test("grepAny walks candidates until one matches", async () => {
		const dir = fixture({ "src/app.ts": "serve /healthz here" });
		const rep = await runRepoPolicies(dir, {
			rows: [
				row({
					check: [
						{ grepAny: ["src/server.ts", "src/app.ts"], pattern: "/healthz" },
					],
				}),
			],
		});
		expect(rep.satisfied).toEqual(["t-row"]);
		const gap = await runRepoPolicies(dir, {
			rows: [
				row({ check: [{ grepAny: ["src/server.ts"], pattern: "/healthz" }] }),
			],
		});
		expect(gap.gaps).toHaveLength(1);
		cleanup(dir);
	});
	test("httpGet: base required (else skip), <500 or expect passes", async () => {
		const cond = (over: object): Condition[] => [
			{ httpGet: "/health", ...over } as unknown as Condition,
		];
		const dir = fixture({ LICENSE: "MIT" });
		const skip = await runRepoPolicies(dir, {
			rows: [row({ check: cond({}) })],
		});
		expect(skip.gaps).toEqual([]);
		expect(skip.skips).toEqual([
			{ id: "t-row", repoClass: "any", reason: "no base_url" },
		]);
		const ok = await runRepoPolicies(dir, {
			rows: [row({ check: cond({}) })],
			baseUrl: "http://x.test",
			fetch: (async () => new Response("ok", { status: 200 })) as typeof fetch,
		});
		expect(ok.satisfied).toEqual(["t-row"]);
		const err5xx = await runRepoPolicies(dir, {
			rows: [row({ check: cond({}) })],
			baseUrl: "http://x.test",
			fetch: (async () => new Response("bad", { status: 503 })) as typeof fetch,
		});
		expect(err5xx.gaps).toHaveLength(1);
		const expect404 = await runRepoPolicies(dir, {
			rows: [row({ check: cond({ expect: 200 }) })],
			baseUrl: "http://x.test",
			fetch: (async () => new Response("nf", { status: 418 })) as typeof fetch,
		});
		expect(expect404.gaps).toHaveLength(1);
		cleanup(dir);
	});
	test("httpGet probe failure = honest skip, not a gap", async () => {
		const dir = fixture({ LICENSE: "MIT" });
		const rep = await runRepoPolicies(dir, {
			rows: [row({ check: [{ httpGet: "/health" }] })],
			baseUrl: "http://x.test",
			fetch: (async () => {
				throw new Error("conn refused");
			}) as typeof fetch,
		});
		expect(rep.gaps).toEqual([]);
		expect(rep.skips[0]?.reason).toContain("probe failed: conn refused");
		cleanup(dir);
	});
});

describe("row runner semantics", () => {
	test("detect fail = row inert; absent detect = every repo", async () => {
		const dir = fixture({});
		const inert = await runRepoPolicies(dir, {
			rows: [row({ detect: [{ exists: "upstreams.yaml" }] })],
		});
		expect(inert.applied).toBe(0);
		expect(inert.gaps).toEqual([]);
		const applied = await runRepoPolicies(dir, { rows: [row({})] });
		expect(applied.applied).toBe(1);
		cleanup(dir);
	});
	test("a gap carries exactly one actionable missing-question", async () => {
		const dir = fixture({});
		const rep = await runRepoPolicies(dir, {
			rows: [
				row({
					repoClass: "api",
					check: [{ exists: "openapi.yaml" }],
					missingQuestion: "which spec describes this API?",
					policySource: "fact:finding.ikea-spec",
				}),
			],
		});
		expect(rep.gaps).toEqual([
			{
				id: "t-row",
				repoClass: "api",
				missingQuestion: "which spec describes this API?",
				policySource: "fact:finding.ikea-spec",
			},
		]);
		cleanup(dir);
	});
	test("sid echoes into the report; satisfied stays silent", async () => {
		const dir = fixture({ LICENSE: "MIT" });
		const rep = await runRepoPolicies(dir, { rows: [row({})], sid: "S1" });
		expect(rep.sid).toBe("S1");
		expect(rep.satisfied).toEqual(["t-row"]);
		expect(rep.gaps).toEqual([]);
		cleanup(dir);
	});
});

describe("loader chain", () => {
	test("committed default parses: 3 rows, stable ids", () => {
		const { rows, source } = loadRepoPolicies();
		expect(source.endsWith("repo-policy.yaml")).toBe(true);
		expect(rows.map((r) => r.id)).toEqual([
			"api-health-endpoint",
			"repo-license",
			"repo-ci",
		]);
		expect(rows.every((r) => r.missingQuestion.length > 0)).toBe(true);
	});
	test("explicit path wins over env and defaults", () => {
		const dir = fixture({});
		const path = join(dir, "rows.yaml");
		writeFileSync(
			path,
			`rows:\n  - id: mine\n    repoClass: any\n    check:\n      - exists: LICENSE\n    missingQuestion: q?\n    policySource: commit\n`,
		);
		const { rows } = loadRepoPolicies(path);
		expect(rows.map((r) => r.id)).toEqual(["mine"]);
		cleanup(dir);
	});
	test("malformed row throws naming the row", () => {
		const dir = fixture({});
		const path = join(dir, "bad.yaml");
		writeFileSync(
			path,
			`rows:\n  - repoClass: any\n    check:\n      - exists: x\n`,
		);
		expect(() => loadRepoPolicies(path)).toThrow(/missing id/);
		cleanup(dir);
	});
});

describe("committed rows on this repo", () => {
	test("api + license rows satisfied on the buckle worktree", async () => {
		const { rows } = loadRepoPolicies();
		const rep = await runRepoPolicies(`${import.meta.dir}/..`, { rows });
		expect(rep.satisfied).toContain("api-health-endpoint");
		expect(rep.satisfied).toContain("repo-license");
		// repo-ci is deliberately NOT asserted: buckle has no CI config today
		// (the honest gap the engine reports on itself) and adding CI must
		// not rot this test — the row outcome belongs to the operator.
	});
	test("a fixture without LICENSE or CI reports both gaps with questions", async () => {
		const { rows } = loadRepoPolicies();
		const dir = fixture({ "src/server.ts": "GET /health" });
		const rep = await runRepoPolicies(dir, { rows });
		expect(rep.applied).toBe(3);
		expect(rep.gaps.map((g) => g.id)).toEqual(["repo-license", "repo-ci"]);
		expect(rep.gaps.every((g) => g.missingQuestion.length > 10)).toBe(true);
		cleanup(dir);
	});
});

describe("POST /repo-policy/check route", () => {
	test("happy path + metering + sid echo", async () => {
		const incs: string[] = [];
		const watchSm = {
			counter: (name: string) => ({
				inc: (labels: Record<string, string>) =>
					incs.push(`${name}:${labels.row}:${labels.outcome}`),
			}),
		} as unknown as Servicemon;
		const dir = fixture({ LICENSE: "MIT" });
		const d: RepoPolicyDeps = { rows: [row({})], sm: watchSm };
		const res = await repoPolicyRoutes(
			d,
			new Request("http://x/repo-policy/check", {
				method: "POST",
				body: JSON.stringify({ repo_root: dir, sid: "S9" }),
			}),
			"/repo-policy/check",
		);
		expect(res).not.toBeNull();
		const body = (await (res as Response).json()) as {
			ok: boolean;
			sid: string | null;
			satisfied: string[];
		};
		expect(body.ok).toBe(true);
		expect(body.sid).toBe("S9");
		expect(body.satisfied).toEqual(["t-row"]);
		expect(incs).toContain("buckle_repo_policy_checks_total:t-row:satisfied");
		cleanup(dir);
	});
	test("400 on missing/non-directory repo_root and bad JSON", async () => {
		const call = (body: string): Promise<Response | null> =>
			repoPolicyRoutes(
				deps([row({})]),
				new Request("http://x/repo-policy/check", { method: "POST", body }),
				"/repo-policy/check",
			);
		const noRoot = await call(JSON.stringify({}));
		expect((noRoot as Response).status).toBe(400);
		const badDir = await call(
			JSON.stringify({ repo_root: "/definitely/absent" }),
		);
		expect((badDir as Response).status).toBe(400);
		const badJson = await call("{not json");
		expect((badJson as Response).status).toBe(400);
	});
	test("unknown path falls through (null) — main dispatch 404s", async () => {
		const res = await repoPolicyRoutes(
			deps([row({})]),
			new Request("http://x/repo-policy/other", { method: "POST", body: "{}" }),
			"/repo-policy/other",
		);
		expect(res).toBeNull();
	});
});

describe("resolvePolicySource (LOCAL-ONLY fact expansion)", () => {
	test("non-fact sources pass through untouched", async () => {
		expect(await resolvePolicySource("commit")).toBe("commit");
	});
	test("fact:<name> expands via the injected runner; failures honest", async () => {
		const ok = await resolvePolicySource(
			"fact:finding.ikea-spec",
			async () => ({
				code: 0,
				text: "IKEA internal: every API repo ships /healthz (ref POL-7)\n",
			}),
		);
		expect(ok).toBe("IKEA internal: every API repo ships /healthz (ref POL-7)");
		const fail = await resolvePolicySource("fact:missing", async () => ({
			code: 1,
			text: "",
		}));
		expect(fail).toBe("fact:missing (coord fact get exit 1)");
		const empty = await resolvePolicySource("fact:empty", async () => ({
			code: 0,
			text: "  \n",
		}));
		expect(empty).toBe("fact:empty (empty fact)");
	});
});
