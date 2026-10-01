// src/gov/federation-manifest.ts — W154: the policy manifest content side.
// rules[] mirror the hub routing-policy.yaml blocks a spoke reconciles
// (generic {id, kind, target, ...} envelope — W164 repo-scoped laws ride the
// same shape); version is content-addressed (same rules → same string) so a
// spoke detects policy change by comparing one field.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { GatewayPolicy } from "../policy.ts";
import type { CrRow } from "./federation.ts";

export interface FedManifest {
	version: string;
	rules: Array<Record<string, unknown>>;
	cr_queue: CrRow[];
}

/** Policy rules for the spoke side (config-over-code: the YAML blocks a
 *  spoke reconciles through its own trusted paths — W147 settings writer,
 *  coord inbox, installer; never a raw file copy). */
export function buildRules(
	policy: GatewayPolicy,
): Array<Record<string, unknown>> {
	const rules: Array<Record<string, unknown>> = [
		{
			id: "gateway.knobs",
			kind: "gateway",
			target: null,
			data: {
				num_retries: policy.num_retries ?? null,
				allowed_fails: policy.allowed_fails ?? null,
				cooldown_time: policy.cooldown_time ?? null,
			},
		},
	];
	for (const [group, tiers] of Object.entries(policy.fallbacks ?? {})) {
		rules.push({
			id: `ladder.${group}`,
			kind: "ladder",
			target: group,
			tiers,
		});
	}
	for (const [group, tags] of Object.entries(policy.tags ?? {})) {
		rules.push({ id: `tags.${group}`, kind: "tags", target: group, tags });
	}
	for (const [name, block] of Object.entries(policy.aids ?? {})) {
		rules.push({ id: `aids.${name}`, kind: "aids", target: name, block });
	}
	return rules;
}

/** Content-addressed manifest version: same rules → same version, so a
 *  spoke detects policy change by comparing one string. */
export function manifestVersion(rules: Array<Record<string, unknown>>): string {
	return `fed-${createHash("sha256")
		.update(JSON.stringify(rules))
		.digest("hex")
		.slice(0, 12)}`;
}

/** The CR queue a spoke must reconcile, oldest first. */
export function crQueue(db: Database): CrRow[] {
	return db
		.query("SELECT * FROM federation_cr_queue ORDER BY declared_at, id")
		.all() as CrRow[];
}

/** Hub-side CR origination seam (W160 wires the origins — belt originates
 *  LLM-policy CRs, central suspenders work-graph CRs). Idempotent on id. */
export function declareCR(
	db: Database,
	spec: { id: string; action: string; target: string },
): CrRow {
	db.query(
		"INSERT INTO federation_cr_queue (id, action, target, declared_at, state) VALUES (?, ?, ?, ?, 'declared') ON CONFLICT(id) DO NOTHING",
	).run(spec.id, spec.action, spec.target, new Date().toISOString());
	return db
		.query("SELECT * FROM federation_cr_queue WHERE id = ?")
		.get(spec.id) as CrRow;
}

/** Linear lifecycle declared→delivered→applied→verified→reported-up, plus
 *  failed from any live state; reported-up/failed are terminal. */
const CR_NEXT: Record<string, string | null> = {
	declared: "delivered",
	delivered: "applied",
	applied: "verified",
	verified: "reported-up",
	"reported-up": null,
	failed: null,
};

function nextCrState(state: string): string | null {
	return state in CR_NEXT ? (CR_NEXT[state] ?? null) : null;
}

function crLive(state: string): boolean {
	return nextCrState(state) !== null;
}

/** Spoke-reported CR state transition, enforced server-side: only the
 *  lifecycle's next state (or failed-from-live) is accepted; 409-mapped
 *  rejection otherwise. Returns the fresh row for the response. */
export function transitionCR(
	db: Database,
	id: string,
	to: string,
	note: string | null,
):
	| { ok: true; row: CrRow }
	| { ok: false; status: number; code: string; why: string } {
	const current = db
		.query("SELECT * FROM federation_cr_queue WHERE id = ?")
		.get(id) as CrRow | null;
	if (current === null)
		return {
			ok: false,
			status: 404,
			code: "buckle.no_route",
			why: `no such CR: ${id}`,
		};
	const allowed = nextCrState(current.state);
	const failedOk = to === "failed" && crLive(current.state);
	if (allowed === null || (to !== allowed && !failedOk)) {
		return {
			ok: false,
			status: 409,
			code: "buckle.cr_state",
			why: `CR ${id} is '${current.state}'; expected '${String(allowed)}'${to === "failed" ? " or failed" : ""}`,
		};
	}
	const ts = Date.now();
	db.query(
		"UPDATE federation_cr_queue SET state = ?, note = ?, updated_at = ?, reported_at = ? WHERE id = ?",
	).run(to, note, ts, to === "reported-up" ? ts : current.reported_at, id);
	return {
		ok: true,
		row: db
			.query("SELECT * FROM federation_cr_queue WHERE id = ?")
			.get(id) as CrRow,
	};
}
