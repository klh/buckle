// src/candidates.ts — the candidate table (W136 §3): buckle's pool as
// in-memory rows the decision path reads pure-memory (<1ms law — health and
// metrics never touched in the decision path; the table is background-
// refreshed). One row per (group, deployment) pair — the wire id (dep.model
// ?? group) is what clients ask for and what the model: glob matches.
//
// Health = own request outcomes only: a deployment benched into cooldown
// (allowed_fails consecutive failures) is unhealthy; nothing probes the
// network here. estimate_ms = in-memory EWMA of own outcomes; load =
// in-flight concurrency right now (first-pass load_5m approximation).
// flashx is ABSENT structurally: flashx groups never become rows (W124
// owner directive; the law enforces itself through data absence).
import type { Cooldowns } from "./cooldown.ts";
import { FLASHX, type GatewayPolicy } from "./policy.ts";
import type { Deployment, Dialect, UpstreamPool } from "./upstreams.ts";

export type Kind = "local" | "remote" | "cloud";

export interface CandidateRow {
	candidate_id: string; // host:port:model
	kind: Kind;
	host: string;
	port: number;
	model: string; // dep.model ?? group — the wire id this row serves
	dialect: Dialect;
	group: string;
	capability_text: string; // tags block + wire id — what tag regexps match
	dep: Deployment; // the pool deployment behind the row (walk executes it)
	healthy: boolean;
	estimate_ms: number | null; // EWMA of own outcomes; null = unproven
	calls: number;
	errors: number;
	load: number; // in-flight right now (first-pass load_5m)
	last_used: string | null;
}

export interface DepRef {
	group: string;
	dep: Deployment;
}

interface Metrics {
	calls: number;
	errors: number;
	ewms: number | null;
	last_used: string | null;
	inflight: number;
}

/** candidate_id for a pool deployment (host:port:model). */
export function candIdOf(dep: Deployment): string {
	const u = new URL(dep.url);
	const port = u.port || (u.protocol === "https:" ? "443" : "80");
	return `${u.hostname}:${port}:${dep.model ?? dep.group}`;
}

/** Loopback = local; anything else in the pool = cloud (no LAN remotes in
 *  buckle's pool yet — "remote" is reserved for remotes.json integration). */
export function kindOfHost(host: string): Kind {
	if (host === "127.0.0.1" || host === "localhost" || host === "::1")
		return "local";
	return "cloud";
}

// ─── the table ───
export interface CandidateTableDeps {
	pool: UpstreamPool;
	policy: GatewayPolicy;
	cooldowns: Cooldowns;
}

/** The in-memory candidate table. snapshot() is the decision path's only
 *  touchpoint — a plain array read. rebuild() is background work. */
export class CandidateTable {
	private rows: CandidateRow[] = [];
	private readonly refs = new Map<string, DepRef>();
	private readonly met = new Map<string, Metrics>();
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly deps: CandidateTableDeps) {
		this.rebuild();
	}

	/** The decision path's view. Read-only discipline: decide() copies via
	 *  sort/map and never mutates rows. */
	snapshot(): readonly CandidateRow[] {
		return this.rows;
	}

	/** Ref for the walk: pool deployment behind a candidate id. */
	refFor(candidateId: string): DepRef | undefined {
		return this.refs.get(candidateId);
	}

	/** Current row for a candidate id (delivered-target lookup). */
	rowFor(candidateId: string): CandidateRow | undefined {
		return this.rows.find((r) => r.candidate_id === candidateId);
	}

	/** Pool group names whose candidates are cloud-kind. */
	cloudGroups(): Set<string> {
		const out = new Set<string>();
		for (const r of this.rows) if (r.kind === "cloud") out.add(r.group);
		return out;
	}

	/** EWMA α=0.3; null → first observation. In-memory first pass. Patches
	 *  the live row too — the next decision sees the new estimate without
	 *  waiting for the refresh tick. */
	recordOutcome(candidateId: string, ms: number, ok: boolean): void {
		const m = this.met.get(candidateId);
		if (!m) return;
		m.calls++;
		if (!ok) m.errors++;
		m.ewms =
			m.ewms === null ? Math.round(ms) : Math.round(0.7 * m.ewms + 0.3 * ms);
		m.last_used = new Date().toISOString();
		const row = this.rows.find((r) => r.candidate_id === candidateId);
		if (!row) return;
		row.estimate_ms = m.ewms;
		row.calls = m.calls;
		row.errors = m.errors;
		row.last_used = m.last_used;
	}

	/** First-pass load: in-flight request count for a candidate. */
	inflight(candidateId: string, delta: number): void {
		const m = this.met.get(candidateId);
		if (!m) return;
		m.inflight = Math.max(0, m.inflight + delta);
		const row = this.rows.find((r) => r.candidate_id === candidateId);
		if (row) row.load = m.inflight;
	}

	/** Background refresh: re-walk the pool; metrics persist by id. */
	rebuild(): void {
		const deps = this.deps;
		const rows: CandidateRow[] = [];
		this.refs.clear();
		for (const group of deps.pool.groups()) {
			if (FLASHX.test(group)) continue; // NEVER flashx — structural
			for (const dep of deps.pool.deployments(group)) {
				const id = candIdOf(dep);
				const u = new URL(dep.url);
				const old = this.met.get(id);
				this.met.set(id, old ?? freshMetrics());
				this.refs.set(id, { group, dep });
				rows.push({
					candidate_id: id,
					kind: kindOfHost(u.hostname),
					host: u.hostname,
					port: Number(u.port || (u.protocol === "https:" ? "443" : "80")),
					model: dep.model ?? group,
					dialect: dep.dialect,
					group,
					capability_text: capabilityText(group, dep, deps.policy.tags),
					dep,
					healthy: !deps.cooldowns.benched(dep),
					estimate_ms: old?.ewms ?? null,
					calls: old?.calls ?? 0,
					errors: old?.errors ?? 0,
					load: old?.inflight ?? 0,
					last_used: old?.last_used ?? null,
				});
			}
		}
		this.rows = rows;
	}

	/** Start/stop the background refresh loop (default 5s). */
	start(intervalMs = 5000): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.rebuild(), intervalMs);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}

function freshMetrics(): Metrics {
	return { calls: 0, errors: 0, ewms: null, last_used: null, inflight: 0 };
}

/** Capability text = the policy tags block + the wire id (W136 §3.2). */
function capabilityText(
	group: string,
	dep: Deployment,
	tags: Record<string, string[]> | undefined,
): string {
	const words = tags?.[group] ?? [];
	return [...words, dep.model ?? group].join(" ");
}
