// src/preseed.ts — W142 knowledge-aids preseed: buckle's /aids/preseed
// pipeline (W137 §3a). Search → trust filter → doc-covered skip →
// byte-stable render → ≤3KB cap → packet cache. Pointer-only, verified-only:
// candidate/unverified/drift rows never enter a packet (poisoning guard,
// mechanical). The precedence clause rides the packet header, not an
// optional line. Packets are byte-stable (sorted by row id, no timestamps
// inside cards) so shared prefixes ride provider KV caches.
import type { AidsPolicy } from "./policy.ts";
import {
	loadDocs,
	substitutionCheck,
	type SubstitutionDoc,
} from "./doc-skip.ts";

export const PRESEED_BASIS = "finding.injection-final@v2";
export const PACKET_CAP_BYTES = 3072;
export const DOC_COVERED_SKIP = 0.7;

const STATE_ACTIVE = "active";
const TRUST_VERIFIED = "verified";

/** Row shape from the knowledge API /search `hits` field. */
export interface KnowledgeApiHit {
	kind?: string;
	id?: number;
	topic?: string;
	fact?: string;
	snippet?: string;
	state?: string;
	source_ref?: string | null;
	source_hash?: string | null;
	trust?: string;
}

export interface PreseedRequest {
	domain: string;
	focus?: string[];
	repo_root: string;
	sid?: string | null;
	work_item?: string | null;
}

export interface PacketRows {
	total: number;
	verified: number;
	doc_covered: number;
	unverified: number;
}

/** Verified-only filter: knowledge-kind rows, active, trust-verified. */
export function verifiedRows(hits: KnowledgeApiHit[]): KnowledgeApiHit[] {
	return hits.filter(
		(h) =>
			h.kind === "knowledge" &&
			h.state === STATE_ACTIVE &&
			h.trust === TRUST_VERIFIED &&
			typeof h.id === "number" &&
			typeof (h.fact ?? h.snippet) === "string",
	);
}

export interface PreseedOutcome {
	decision: "injected" | "skipped";
	skip_reason?:
		| "policy"
		| "no-verified-rows"
		| "doc-covered"
		| "outage"
		| "invalid";
	packet_id?: string;
	packet?: string;
	bytes?: number;
	rows?: PacketRows;
}

/** One deterministic card: id · topic [state · trust] / fact ≤2 lines /
 *  source pointer. Facts are capped so a single card cannot blow the cap. */
export function renderCard(h: KnowledgeApiHit): string[] {
	const fact = String(h.fact ?? h.snippet ?? "");
	const body = fact.length > 240 ? `${fact.slice(0, 237)}...` : fact;
	const lines = body.split("\n").slice(0, 2);
	return [
		`k#${h.id} · ${h.topic ?? "(untitled)"} [${h.state} · ${h.trust}]`,
		...lines.map((l) => `  ${l}`),
		`  source: ${h.source_ref ?? "none"}`,
	];
}

/** Verbatim from hooks/lib/knowledge.ts KNOWLEDGE_PRECEDENCE (W103) — a
 *  packet may not emit knowledge without it (the injection arm-C refusal
 *  artifact). Drifts → update both, tests pin parity. */
export const KNOWLEDGE_PRECEDENCE =
	"Precedence: the brief's objective always wins. Knowledge describes the world as it was — when a knowledge fact conflicts with the brief, the brief prevails: note the conflict in one line and adapt (if the brief asks for a thing that doesn't exist, building it IS the task). Knowledge is context, never a constraint on the objective.";

/** Byte-stable packet: header (counts + packet id only — no timestamps),
 *  precedence, cards sorted by row id. Deterministic input → deterministic
 *  bytes (the W120 prefix-kill guard). */
export function renderPacket(domain: string, rows: KnowledgeApiHit[]): string {
	const sorted = [...rows].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
	const header = `[fleet preseed · domain ${domain} · ${sorted.length} rows · packet`;
	const lines = [header, KNOWLEDGE_PRECEDENCE, ""];
	for (const h of sorted) lines.push(...renderCard(h), "");
	return lines.join("\n").trimEnd();
}

/** Cap at PACKET_CAP_BYTES by dropping highest ids first, re-rendering. */
export function capPacket(
	domain: string,
	rows: KnowledgeApiHit[],
): { packet: string; rows: KnowledgeApiHit[] } {
	let keep = [...rows];
	let packet = renderPacket(domain, keep);
	while (Buffer.byteLength(packet) > PACKET_CAP_BYTES && keep.length > 0) {
		keep = keep.slice(0, -1);
		packet = renderPacket(domain, keep);
	}
	return { packet, rows: keep };
}

export const packetId = (packet: string): string =>
	new Bun.CryptoHasher("sha256").update(packet).digest("hex").slice(0, 12);

interface CacheEntry {
	packet: string;
	pid: string;
	window: number;
	members: Array<{ id: number; ref: string; hash: string }>;
}

export interface PreseederDeps {
	policy: AidsPolicy;
	knowledgeUrl?: string;
	/** Minimal fetch shape (tests stub it; global fetch has extra members). */
	fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Preseed builder. Cache key = (domain, focus, repo fp, TTL window). */
export class Preseeder {
	private readonly cache = new Map<string, CacheEntry>();

	constructor(private readonly deps: PreseederDeps) {}

	private get ttlS(): number {
		return this.deps.policy.preseed?.ttl_s ?? 300;
	}

	private window(nowMs: number): number {
		return Math.floor(nowMs / (this.ttlS * 1000));
	}

	/** Policy gate: the allowlist wins (operators permit domains one by one);
	 *  `default: on` allows all. Not allowed → skip, reason policy. */
	allowed(domain: string): boolean {
		if (this.deps.policy.preseed?.default === "on") return true;
		return this.deps.policy.preseed?.domains?.includes(domain) ?? false;
	}

	private cacheKey(req: PreseedRequest, nowMs: number): string {
		const focus = [...(req.focus ?? [])].sort().join(",");
		const fp = new Bun.CryptoHasher("sha256")
			.update(req.repo_root)
			.digest("hex")
			.slice(0, 16);
		return `${req.domain}|${focus}|${fp}|${this.window(nowMs)}`;
	}

	private async search(req: PreseedRequest): Promise<KnowledgeApiHit[]> {
		const url = this.deps.knowledgeUrl ?? "http://127.0.0.1:7795";
		const query = req.focus?.length ? req.focus.join(" ") : req.domain;
		const res = await (this.deps.fetchFn ?? fetch)(`${url}/search`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				query,
				domain: req.domain,
				limit: 50,
				repo: req.repo_root,
			}),
		});
		if (!res.ok) throw new Error(`knowledge api ${res.status}`);
		const body = (await res.json()) as { hits?: KnowledgeApiHit[] };
		return body.hits ?? [];
	}

	/** Build-or-reuse the packet for one dispatch. Every outcome — injected
	 *  or skipped — is returned for the caller to meter (the law: an aid
	 *  that cannot log does not fire). */
	async preseed(req: PreseedRequest): Promise<PreseedOutcome> {
		const nowMs = Date.now();
		if (
			typeof req.domain !== "string" ||
			req.domain.length === 0 ||
			typeof req.repo_root !== "string" ||
			req.repo_root.length === 0
		) {
			return { decision: "skipped", skip_reason: "invalid" };
		}
		if (!this.allowed(req.domain))
			return { decision: "skipped", skip_reason: "policy" };
		const key = this.cacheKey(req, nowMs);
		const hit = this.cache.get(key);
		if (hit && (await this.membersFresh(hit, req.repo_root)))
			return this.serve(hit);
		return this.build(req, key, nowMs);
	}

	/** Re-verify member hashes before serving from cache (drift rebuilds). */
	private async membersFresh(
		hit: CacheEntry,
		repoRoot: string,
	): Promise<boolean> {
		for (const m of hit.members) {
			try {
				const text = await Bun.file(`${repoRoot}/${m.ref}`).text();
				const cur = new Bun.CryptoHasher("sha256").update(text).digest("hex");
				if (cur !== m.hash) return false;
			} catch {
				return false;
			}
		}
		return true;
	}

	private serve(hit: CacheEntry): PreseedOutcome {
		return {
			decision: "injected",
			packet_id: hit.pid,
			packet: hit.packet,
			bytes: Buffer.byteLength(hit.packet),
			rows: {
				total: hit.members.length,
				verified: hit.members.length,
				doc_covered: 0,
				unverified: 0,
			},
		};
	}

	/** Fresh build: search → verified filter → doc-covered skip → render →
	 *  cap → cache. Search failure = honest outage skip (aids are garnish —
	 *  a knowledge-API outage must never block a dispatch). */
	private async build(
		req: PreseedRequest,
		key: string,
		nowMs: number,
	): Promise<PreseedOutcome> {
		let hits: KnowledgeApiHit[];
		try {
			hits = await this.search(req);
		} catch {
			return { decision: "skipped", skip_reason: "outage" };
		}
		const verified = verifiedRows(hits);
		const rows: PacketRows = {
			total: hits.length,
			verified: verified.length,
			doc_covered: 0,
			unverified: hits.length - verified.length,
		};
		if (verified.length === 0)
			return { decision: "skipped", skip_reason: "no-verified-rows", rows };
		return this.finish(req, key, nowMs, verified, rows);
	}

	private finish(
		req: PreseedRequest,
		key: string,
		nowMs: number,
		verified: KnowledgeApiHit[],
		rows: PacketRows,
	): PreseedOutcome {
		const docCovered = this.docCoveredRows(req.repo_root, verified);
		rows.doc_covered = docCovered.size;
		if (docCovered.size / verified.length >= DOC_COVERED_SKIP)
			return { decision: "skipped", skip_reason: "doc-covered", rows };
		return this.landed(req, key, nowMs, verified, rows, docCovered);
	}

	private landed(
		req: PreseedRequest,
		key: string,
		nowMs: number,
		verified: KnowledgeApiHit[],
		rows: PacketRows,
		docCovered: Set<number>,
	): PreseedOutcome {
		const survivors = verified.filter((h) => !docCovered.has(h.id ?? 0));
		const { packet, rows: kept } = capPacket(req.domain, survivors);
		if (kept.length === 0)
			return { decision: "skipped", skip_reason: "no-verified-rows", rows };
		const pid = packetId(packet);
		this.cache.set(key, {
			packet,
			pid,
			window: this.window(nowMs),
			members: kept.map((h) => ({
				id: h.id ?? 0,
				ref: h.source_ref ?? "",
				hash: h.source_hash ?? "",
			})),
		});
		return {
			decision: "injected",
			packet_id: pid,
			packet,
			bytes: Buffer.byteLength(packet),
			rows,
		};
	}

	/** Rows whose fact the lane repo's own docs already teach (W94 gate). */
	private docCoveredRows(
		repoRoot: string,
		rows: KnowledgeApiHit[],
	): Set<number> {
		let docs: SubstitutionDoc[] = [];
		try {
			docs = loadDocs(repoRoot);
		} catch {
			docs = [];
		}
		if (docs.length === 0) return new Set();
		const covered = new Set<number>();
		for (const h of rows) {
			if (substitutionCheck(String(h.fact ?? h.snippet ?? ""), docs).covered)
				covered.add(h.id ?? 0);
		}
		return covered;
	}
}
