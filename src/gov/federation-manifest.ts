// src/gov/federation-manifest.ts — W154: the policy manifest content side.
// rules[] mirror the hub routing-policy.yaml blocks a spoke reconciles
// (generic {id, kind, target, ...} envelope — W164 repo-scoped laws ride the
// same shape); version is content-addressed (same rules → same string) so a
// spoke detects policy change by comparing one field.
// W193: CR rows carry claim binding — the first spoke report from `declared`
// binds the CR to that principal; other non-admin principals cannot move it.
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

/** W160 CR origination: who/what declared, when (declared_at). system names
 *  the originate side — belt (LLM-policy) or suspenders (work-graph/rules). */
export interface CrOrigin {
	system: string;
	actor: string;
}

export interface CrSpec {
	id: string;
	action: string;
	target: string;
	/** The change the spoke must reconcile (JSON-serializable). */
	payload?: unknown;
	/** Required: origination record (who declared, on whose behalf). */
	origin: CrOrigin;
}

export type CrDeclare =
	| { ok: true; row: CrRow }
	| { ok: false; code: string; why: string };

/** The domain-separation guard, structural (owner law: the CR channel NEVER
 *  carries private-domain content). Deep-walks a declared CR's payload and
 *  origin for W154 provenance markers — any `data_domain: "private"` anywhere
 *  rejects the declare — and returns the offending path, or null when clean.
 *  `data_domain: "hub"` and absence pass. */
export function crPrivateDomainPath(value: unknown, path = "$"): string | null {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const hit = crPrivateDomainPath(value[i], `${path}[${String(i)}]`);
			if (hit !== null) return hit;
		}
		return null;
	}
	if (value !== null && typeof value === "object") {
		for (const [k, v] of Object.entries(value)) {
			const child = `${path}.${k}`;
			if (k === "data_domain" && v === "private") return child;
			const hit = crPrivateDomainPath(v, child);
			if (hit !== null) return hit;
		}
	}
	return null;
}

/** Declare-time validation: body shape + required origin record + the
 *  structural domain guard, before any row exists. */
function crDeclareRejection(spec: CrSpec): CrDeclare | null {
	if (typeof spec.id !== "string" || spec.id.length === 0)
		return { ok: false, code: "buckle.cr_body", why: "missing id" };
	if (typeof spec.action !== "string" || spec.action.length === 0)
		return { ok: false, code: "buckle.cr_body", why: "missing action" };
	if (typeof spec.target !== "string" || spec.target.length === 0)
		return { ok: false, code: "buckle.cr_body", why: "missing target" };
	if (
		spec.origin === null ||
		typeof spec.origin !== "object" ||
		typeof spec.origin.system !== "string" ||
		spec.origin.system.length === 0 ||
		typeof spec.origin.actor !== "string" ||
		spec.origin.actor.length === 0
	)
		return {
			ok: false,
			code: "buckle.cr_origin",
			why: "origin required: {system, agent} — CRs record who/what declared them",
		};
	const hit =
		crPrivateDomainPath(spec.payload) ?? crPrivateDomainPath(spec.origin);
	if (hit !== null)
		return {
			ok: false,
			code: "buckle.cr_private_domain",
			why: `content at ${hit} is marked/derived data_domain=private — the CR channel never carries private-domain content (domain separation, federation doc)`,
		};
	return null;
}

/** Hub-side CR origination seam (W160): belt originates LLM-policy CRs,
 *  central suspenders work-graph/rules CRs — same queue, same lifecycle.
 *  Records the origin (who/what, declared_at); the structural domain guard
 *  runs HERE, before any row exists. Idempotent on id. */
export function declareCR(db: Database, spec: CrSpec): CrDeclare {
	const rej = crDeclareRejection(spec);
	if (rej !== null) return rej;
	const payloadJson =
		spec.payload === undefined ? null : JSON.stringify(spec.payload);
	db.query(
		"INSERT INTO federation_cr_queue (id, action, target, declared_at, state, payload, origin) VALUES (?, ?, ?, ?, 'declared', ?, ?) ON CONFLICT(id) DO NOTHING",
	).run(
		spec.id,
		spec.action,
		spec.target,
		new Date().toISOString(),
		payloadJson,
		JSON.stringify(spec.origin),
	);
	return {
		ok: true,
		row: db
			.query("SELECT * FROM federation_cr_queue WHERE id = ?")
			.get(spec.id) as CrRow,
	};
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

/** W160: the hub-side verification probe. Before a CR may report `verified`,
 *  the hub re-reads the CR's target surface to confirm the change actually
 *  landed — spoke claims are never trusted alone. */
export type CrProbe = (cr: CrRow) => { ok: boolean; why: string | null };

/** W193 claim identity: the reporting principal's stable id plus whether it
 *  holds hub-admin capability (admins/root may move any CR; spokes only
 *  their own claims). */
export interface CrActor {
	id: string;
	admin: boolean;
}

/** Spoke-reported CR state transition, enforced server-side: only the
 *  lifecycle's next state (or failed-from-live) is accepted; 409-mapped
 *  rejection otherwise. applied→verified additionally requires the hub's
 *  verification probe to pass. Returns the fresh row for the response. */
export function transitionCR(
	db: Database,
	id: string,
	to: string,
	note: string | null,
	probe?: CrProbe,
	actor?: CrActor,
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
	if (to === "verified" && current.state === "applied") {
		if (probe === undefined)
			return {
				ok: false,
				status: 409,
				code: "buckle.cr_probe",
				why: `CR ${id}: verified requires a hub verification probe; none registered for target '${current.target}'`,
			};
		const v = probe(current);
		if (!v.ok)
			return {
				ok: false,
				status: 409,
				code: "buckle.cr_probe",
				why: `CR ${id}: verification probe failed — ${v.why ?? "target not confirmed"}`,
			};
	}
	const claimant = actor ?? null;
	if (
		current.claimed_by !== null &&
		claimant !== null &&
		claimant.admin === false &&
		claimant.id !== current.claimed_by
	)
		return {
			ok: false,
			status: 403,
			code: "buckle.cr_claimed",
			why: `CR ${id} is claimed by '${current.claimed_by}'; reports only from the claimant (or hub-admin)`,
		};
	const ts = Date.now();
	db.query(
		"UPDATE federation_cr_queue SET state = ?, note = ?, updated_at = ?, reported_at = ?, verified_at = ?, claimed_by = COALESCE(claimed_by, ?), claimed_at = COALESCE(claimed_at, ?) WHERE id = ?",
	).run(
		to,
		note,
		ts,
		to === "reported-up" ? ts : current.reported_at,
		to === "verified" ? ts : current.verified_at,
		claimant?.id ?? null,
		claimant === null ? null : ts,
		id,
	);
	return {
		ok: true,
		row: db
			.query("SELECT * FROM federation_cr_queue WHERE id = ?")
			.get(id) as CrRow,
	};
}
