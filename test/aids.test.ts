// test/aids.test.ts — W142 knowledge aids: metering law, preseed pipeline,
// cache-align, wire gating, and the aid-rollup seam. Verified-only packets,
// byte-stable renders, est_tok_saved NULL at event time.
import { describe, expect, test } from "bun:test";
import { AidsLedger, parseAids, tokensEstimate } from "../src/aids.ts";
import { alignBody, PACKET_MARKER } from "../src/align.ts";
import {
	capPacket,
	packetId,
	Preseeder,
	renderPacket,
	verifiedRows,
	type KnowledgeApiHit,
} from "../src/preseed.ts";
import { distinctTerms, substitutionCheck } from "../src/doc-skip.ts";
import { aidsRoutes, applyWireAids } from "../src/aids-routes.ts";
import type { AidsDeps } from "../src/aids-routes.ts";
import { servicemon } from "../src/servicemon.ts";
import type { AidsPolicy } from "../src/policy.ts";

const mkDeps = (policy: AidsPolicy): AidsDeps => ({
	aids: new AidsLedger(":memory:"),
	preseeder: new Preseeder({ policy }),
	aidsPolicy: policy,
	sm: servicemon({ service: "t", port: 0 }),
});

const POLICY_ON: AidsPolicy = {
	preseed: { default: "on", domains: ["gaps"] },
	"cache-align": { default: "on" },
	compress: { default: "off" },
};

function hit(over: Partial<KnowledgeApiHit>): KnowledgeApiHit {
	return {
		kind: "knowledge",
		id: 1,
		topic: "topic-one",
		fact: "a measured fleet fact",
		state: "active",
		trust: "verified",
		source_ref: "README.md",
		source_hash: "abc",
		...over,
	};
}

describe("parseAids stanza grammar", () => {
	test("preseed + focus + cache-align", () => {
		const s = parseAids("preseed=gaps:work-graph,fleet-loop cache-align");
		expect(s.off).toBe(false);
		expect(s.preseed?.domain).toBe("gaps");
		expect(s.preseed?.focus).toEqual(["work-graph", "fleet-loop"]);
		expect(s["cache-align"]).toBe(true);
	});
	test("off wins over everything; unknown keys logged", () => {
		const s = parseAids("off preseed=gaps compress");
		expect(s.off).toBe(true);
		expect(s.compress).toBe(true);
		const u = parseAids("preseed=gaps teleport");
		expect(u.unknown).toEqual(["teleport"]);
	});
});

describe("metering law", () => {
	test("est_tok_saved NULL at event time; dup idempotent", () => {
		const l = new AidsLedger(":memory:");
		const ev = {
			ts: 1_791_000_000_000,
			aid: "preseed",
			decision: "injected" as const,
			domain: "gaps",
			sid: "s1",
			tokens_injected: 612,
		};
		const r1 = l.record(ev);
		expect(r1).not.toBeNull();
		expect(r1?.est_tok_saved).toBeUndefined();
		expect(l.record(ev)).toBeNull();
	});
	test("rollup aggregates hourly; eventsSince + status", () => {
		const l = new AidsLedger(":memory:");
		l.record({
			ts: Date.now(),
			aid: "preseed",
			decision: "injected",
			tokens_injected: 612,
		});
		l.record({
			ts: Date.now() + 1000,
			aid: "preseed",
			decision: "skipped",
			skip_reason: "policy",
		});
		expect(l.rollup(24)).toBeGreaterThan(0);
		expect(l.rollupRows(24).length).toBeGreaterThan(0);
		expect(l.eventsSince(0).length).toBe(2);
		expect(l.status().n).toBe(2);
	});
});

describe("preseed pipeline", () => {
	test("verified-only filter", () => {
		const rows = verifiedRows([
			hit({}),
			hit({ state: "candidate" }),
			hit({ trust: "unverified" }),
			hit({ kind: "fact" }),
			hit({ id: undefined }),
		]);
		expect(rows.length).toBe(1);
	});

	test("render is byte-stable + sorted by id; packetId deterministic", () => {
		const a = renderPacket("gaps", [hit({ id: 7 }), hit({ id: 3 })]);
		const b = renderPacket("gaps", [hit({ id: 3 }), hit({ id: 7 })]);
		expect(a).toBe(b);
		expect(a).toContain("[fleet preseed · domain gaps · 2 rows");
		expect(a).toContain("k#3 ·");
		expect(a).toContain("Precedence: the brief's objective always wins.");
		expect(packetId(a)).toBe(
			packetId(renderPacket("gaps", [hit({ id: 3 }), hit({ id: 7 })])),
		);
	});

	test("cap drops highest ids first, stays ≤3KB", () => {
		const many = Array.from({ length: 60 }, (_, i) =>
			hit({
				id: i + 1,
				fact: `fact number ${i} with padding text to grow the packet bytes substantially`,
			}),
		);
		const { packet, rows } = capPacket("gaps", many);
		expect(Buffer.byteLength(packet)).toBeLessThanOrEqual(3072);
		expect(rows.length).toBeLessThan(60);
		const ids = rows.map((r) => r.id ?? 0);
		expect(Math.max(...(ids.length ? ids : [0]))).toBeLessThan(60);
	});
});

describe("Preseeder decisions", () => {
	test("policy gate skips a non-allowlisted domain", async () => {
		const p = new Preseeder({
			policy: { preseed: { default: "off", domains: ["other"] } },
		});
		const out = await p.preseed({
			domain: "gaps",
			repo_root: "/tmp",
			sid: "s",
		});
		expect(out.decision).toBe("skipped");
		expect(out.skip_reason).toBe("policy");
	});

	test("knowledge outage → honest skip", async () => {
		const p = new Preseeder({
			policy: { preseed: { default: "on" } },
			fetchFn: async () => {
				throw new Error("down");
			},
		});
		const out = await p.preseed({ domain: "gaps", repo_root: "/tmp" });
		expect(out.decision).toBe("skipped");
		expect(out.skip_reason).toBe("outage");
	});

	test("injects verified rows; cache hit reuses without a second search", async () => {
		const root = `${import.meta.dir}/.tmp-cache-repo`;
		const readme = "cache-reuse fixture README content";
		await Bun.write(`${root}/README.md`, readme);
		const realHash = new Bun.CryptoHasher("sha256")
			.update(readme)
			.digest("hex");
		let calls = 0;
		const p = new Preseeder({
			policy: { preseed: { default: "on" } },
			fetchFn: async () => {
				calls++;
				return Response.json({
					hits: [
						hit({ source_ref: "README.md", source_hash: realHash }),
						hit({ id: 2, source_ref: "README.md", source_hash: realHash }),
					],
				});
			},
		});
		const req = { domain: "gaps", repo_root: root, sid: "s" };
		const first = await p.preseed(req);
		expect(first.decision).toBe("injected");
		expect(first.packet?.includes("Precedence:")).toBe(true);
		const second = await p.preseed(req);
		expect(second.decision).toBe("injected");
		expect(calls).toBe(1);
	});

	test("doc-covered rows drop; packet still injects the rest", async () => {
		const root = `${import.meta.dir}/.tmp-doc-repo`;
		await Bun.write(
			`${root}/docs/learned.md`,
			"the post-files gate runs qlty-fmt plus fast lint on every write",
		);
		const p = new Preseeder({
			policy: { preseed: { default: "on" } },
			fetchFn: async () =>
				Response.json({
					hits: [
						hit({
							id: 1,
							fact: "the post-files gate runs qlty-fmt plus fast lint on every write",
						}),
						hit({
							id: 2,
							fact: "the subagent pool warms resident models before dispatch",
						}),
					],
				}),
		});
		const out = await p.preseed({ domain: "gaps", repo_root: root });
		expect(out.decision).toBe("injected");
		expect(out.rows?.doc_covered).toBe(1);
	});
});

describe("cache-align", () => {
	test("string system becomes a block array with one breakpoint", () => {
		const body = { model: "m", system: "static preamble", messages: [] };
		const r = alignBody(body, "anthropic");
		expect(r?.placed).toBe("system");
		const sys = r?.body?.system as Array<Record<string, unknown>>;
		expect(Array.isArray(sys)).toBe(true);
		expect(sys.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
	});

	test("packet block carries the breakpoint; idempotent re-run no-ops", () => {
		const packet = `${PACKET_MARKER} · domain gaps · 1 rows · packet x]\nk`;
		const body = {
			model: "m",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: `preamble\n${packet}` }],
				},
			],
		};
		const r1 = alignBody(body, "anthropic");
		expect(r1?.placed).toBe("packet");
		const blk = (body.messages as never)[0] as never as {
			content: Array<Record<string, unknown>>;
		};
		expect(blk.content[0]?.cache_control).toEqual({ type: "ephemeral" });
		expect(alignBody(body, "anthropic")).toBeNull();
	});

	test("openai dialect is a no-op", () => {
		expect(alignBody({ system: "s" }, "openai")).toBeNull();
	});
});

describe("wire aids", () => {
	test("no header → zero touch; compress wired default-off → skip(policy)", async () => {
		const deps = mkDeps({ compress: { default: "off" } });
		const body = { model: "m", system: "s", messages: [] };
		const untouched = await applyWireAids(deps, null, body, "anthropic");
		expect(untouched.body).toBe(body);
		expect(untouched.aligned).toBe(false);
		const comp = await applyWireAids(
			deps,
			"compress",
			{ model: "m", messages: [] },
			"anthropic",
		);
		expect(comp.aligned).toBe(false);
		expect(deps.aids.status().n).toBe(1);
		const row = deps.aids.eventsSince(0)[0] as Record<string, unknown>;
		expect(row.aid).toBe("compress");
		expect(row.skip_reason).toBe("policy");
	});

	test("declared cache-align aligns and meters one injected event", async () => {
		const deps = mkDeps({ "cache-align": { default: "on" } });
		const body = { model: "m", system: "preamble", messages: [] };
		const out = await applyWireAids(deps, "cache-align", body, "anthropic");
		expect(out.aligned).toBe(true);
		const row = deps.aids.eventsSince(0)[0] as Record<string, unknown>;
		expect(row.aid).toBe("cache-align");
		expect(row.decision).toBe("injected");
	});
});

describe("doc-skip mechanics", () => {
	test("substitutionCheck covered vs uncovered", () => {
		const doc = {
			path: "docs/a.md",
			text: "the post-files gate runs qlty-fmt plus fast lint on every write and blocks with the diff inline",
		};
		const covered = substitutionCheck(
			"the post-files gate runs qlty-fmt plus fast lint on every write",
			[doc],
		);
		expect(covered.covered).toBe(true);
		const fresh = substitutionCheck(
			"the subagent pool warms resident models before dispatch each morning",
			[doc],
		);
		expect(fresh.covered).toBe(false);
		expect(
			distinctTerms("the gate, gate-keeper; GATE!").has("gate-keeper"),
		).toBe(true);
	});
});

describe("aids routes", () => {
	test("preseed → rollup end-to-end through the route table", async () => {
		const deps = mkDeps(POLICY_ON);
		const knowledge = Response.json({ hits: [hit({}), hit({ id: 2 })] });
		deps.preseeder = new Preseeder({
			policy: POLICY_ON,
			fetchFn: async () => knowledge,
		});
		const pre = await aidsRoutes(
			deps,
			new Request("http://x/aids/preseed", {
				method: "POST",
				body: JSON.stringify({
					domain: "gaps",
					repo_root: "/tmp",
					sid: "w142-e2e",
					work_item: "W142",
				}),
			}),
			"/aids/preseed",
		);
		if (!pre) throw new Error("preseed route not routed");
		expect(pre.status).toBe(200);
		const body = (await pre.json()) as { decision: string; bytes?: number };
		expect(body.decision).toBe("injected");
		expect(tokensEstimate(body.bytes ?? 0)).toBeGreaterThan(0);
		const bad = await aidsRoutes(
			deps,
			new Request("http://x/aids/preseed", {
				method: "POST",
				body: JSON.stringify({ domain: "" }),
			}),
			"/aids/preseed",
		);
		if (!bad) throw new Error("bad-request route not routed");
		expect(bad.status).toBe(400);
	});
});
