// src/decide.ts — the routing decision, a pure function (W136 law 1:
// zero LLM, zero network — imports no fetch/client, makes no model call).
// must = healthy AND full fit or machine-readable error, NEVER a substitute
// (law 2). prefer = fit-ordered, degrade by policy and say so (law 3).
// No hint = belt's proven default policy (law 4): healthy → proven →
// effMs → errors → LRU, the compareCandidates port. allow_cloud/cost prefs
// gate every cloud hop (law 6, precedence: prefs > hint > tier).
import type { CandidateRow } from "./candidates.ts";
import { hintFit, hintTotal, type RouteHint } from "./hints.ts";
import type { Prefs } from "./policy.ts";

export type DecisionKind = "policy" | "degraded" | "fallback" | "errored";

export type RouteErrorCode =
	| "bad_hint"
	| "no_healthy_fit"
	| "cloud_forbidden"
	| "no_route";

export type LatencyClass = "unproven" | "fast" | "medium" | "slow";

export const LATENCY_THRESHOLDS = { fast: 500, medium: 2000 };

/** estimate_ms → latency class (W136 §5.3; thresholds are first-pass). */
export function latencyClass(estimate_ms: number | null): LatencyClass {
	if (estimate_ms === null) return "unproven";
	if (estimate_ms < LATENCY_THRESHOLDS.fast) return "fast";
	if (estimate_ms < LATENCY_THRESHOLDS.medium) return "medium";
	return "slow";
}

export interface RouteSelection {
	ordered: CandidateRow[]; // delivery order (head first)
	seen: number; // candidates the decision saw
	top: string[]; // top-3 candidate ids for the audit row
	head: CandidateRow; // the selected target
	fit: number; // head's fit at decision time
	total: number; // hint groups the hint carries
	decision: Exclude<DecisionKind, "fallback" | "errored">;
	verb: "prefer" | "must" | null; // drives the must-domain closure in the walk
	cloudGroups: Set<string>;
	prefs: Prefs; // prefs state at decision time (audit + gate)
	why: string;
}

export interface HintError {
	code: Extract<
		RouteErrorCode,
		"no_healthy_fit" | "cloud_forbidden" | "no_route"
	>;
	seen: number;
	why: string;
}

export type DecideResult =
	| { ok: true; sel: RouteSelection }
	| { ok: false; err: HintError };

// ─── belt's proven-latency policy, ported (route-policy.ts) ───
// Proven average with a load penalty; unproven candidates sort to the back
// (never-measured is not fast — conservative on purpose).
const effMs = (c: CandidateRow): number =>
	(c.estimate_ms ?? Number.POSITIVE_INFINITY) * (1 + 0.1 * c.load);

/** Law 4 ordering: healthy → proven → effMs → errors → LRU. Buckle rows
 *  carry no probe RTT; candidate_id is the final deterministic tiebreak
 *  where belt uses probe_ms. */
export function compareCandidates(a: CandidateRow, b: CandidateRow): number {
	if (a.healthy !== b.healthy) return a.healthy ? -1 : 1;
	const provenA = a.calls > 0 && a.estimate_ms !== null;
	const provenB = b.calls > 0 && b.estimate_ms !== null;
	if (provenA !== provenB) return provenA ? -1 : 1;
	if (effMs(a) !== effMs(b))
		return effMs(a) === Number.POSITIVE_INFINITY
			? a.candidate_id.localeCompare(b.candidate_id)
			: effMs(a) - effMs(b);
	if (a.errors !== b.errors) return a.errors - b.errors;
	return (b.last_used ?? "").localeCompare(a.last_used ?? "");
}

/** One honest sentence naming what decided it. */
function decideWhy(head: CandidateRow, fit: number, total: number): string {
	const meas =
		head.estimate_ms !== null
			? `${String(head.estimate_ms)}ms avg over ${String(head.calls)} call(s)`
			: "unproven";
	const fitPart = total > 0 ? ` fit ${String(fit)}/${String(total)}` : "";
	return `${head.candidate_id} (${head.kind})${fitPart} — ${meas}`;
}

/** How many hint groups does the row satisfy (belt's hintFit adapter)? */
const fitOf = (c: CandidateRow, h: RouteHint): number =>
	hintFit(
		{ kind: c.kind, machine: c.host, model: c.model, tags: c.capability_text },
		h,
	);

export interface DecideInput {
	hint: RouteHint | null;
	hintRaw: string;
	candidates: readonly CandidateRow[];
	prefs: Prefs;
	dialect: "openai" | "anthropic";
}

/** The decision (W136 §4). Prefs gate cloud delivery first (precedence 1);
 *  the hint constrains selection (precedence 2). must-empty → HintError —
 *  the router sends nothing upstream. */
export function decideRoute(input: DecideInput): DecideResult {
	const gateOpen = input.prefs.allow_cloud && input.prefs.cost_speed !== "cost";
	const pool = input.candidates.filter(
		(c) => c.dialect === input.dialect && (gateOpen || c.kind !== "cloud"),
	);
	if (input.hint?.verb === "must") return mustPath(input, pool, gateOpen);
	return preferOr(input, pool);
}

const noFitErr = (raw: string, seen: number): HintError => ({
	code: "no_healthy_fit",
	seen,
	why: `must '${raw}': no healthy full fit among ${String(seen)} candidates — must never substitutes`,
});

/** must (law 2): healthy AND fit==total, else machine-readable error.
 *  Owner gate ≠ health condition: `must cloud` with the gate closed is
 *  cloud_forbidden — refuse loudly, never substitute quietly. */
function mustPath(
	input: DecideInput,
	pool: CandidateRow[],
	gateOpen: boolean,
): DecideResult {
	const hint = input.hint;
	if (!hint) return { ok: false, err: noFitErr(input.hintRaw, pool.length) };
	if (
		hint.location &&
		"kind" in hint.location &&
		hint.location.kind === "cloud" &&
		!gateOpen
	)
		return {
			ok: false,
			err: {
				code: "cloud_forbidden",
				seen: pool.length,
				why: `must '${input.hintRaw}': cloud is disabled by owner prefs — must never substitutes`,
			},
		};
	const fits = pool
		.filter((c) => c.healthy && fitOf(c, hint) === hintTotal(hint))
		.sort(compareCandidates);
	const head = fits[0];
	if (!head) return { ok: false, err: noFitErr(input.hintRaw, pool.length) };
	return okSel(input, pool, fits, head, hintTotal(hint));
}

/** The ok-shape both paths share. */
function okSel(
	input: DecideInput,
	pool: CandidateRow[],
	ordered: CandidateRow[],
	head: CandidateRow,
	total: number,
): DecideResult {
	const fit = total > 0 ? fitOf(head, input.hint as RouteHint) : 0;
	return {
		ok: true,
		sel: {
			ordered,
			seen: pool.length,
			top: ordered.slice(0, 3).map((c) => c.candidate_id),
			head,
			fit,
			total,
			decision: fit < total ? "degraded" : "policy",
			verb: input.hint?.verb ?? null,
			cloudGroups: cloudSet(pool),
			prefs: input.prefs,
			why:
				total > 0
					? `hint '${input.hintRaw}': ${decideWhy(head, fit, total)}`
					: decideWhy(head, 0, 0),
		},
	};
}

/** prefer (law 3) and no-hint (law 4): order, don't refuse. Belt's
 *  preferOrdered: fit DESC, policy breaks ties. Head below full fit → the
 *  request proceeds anyway, the audit says degraded. */
function preferOr(input: DecideInput, pool: CandidateRow[]): DecideResult {
	if (pool.length === 0)
		return {
			ok: false,
			err: {
				code: "no_route",
				seen: 0,
				why: `no ${input.dialect} candidates in the pool`,
			},
		};
	const hint = input.hint;
	if (!hint) {
		const ordered = [...pool].sort(compareCandidates);
		const head = ordered[0];
		if (!head)
			return {
				ok: false,
				err: { code: "no_route", seen: 0, why: "no candidates" },
			};
		return okSel(input, pool, ordered, head, 0);
	}
	const ordered = pool
		.map((c) => ({ c, fit: fitOf(c, hint) }))
		.sort((a, b) => b.fit - a.fit || compareCandidates(a.c, b.c))
		.map((x) => x.c);
	const head = ordered[0];
	if (!head) return { ok: false, err: noFitErr(input.hintRaw, pool.length) };
	return okSel(input, pool, ordered, head, hintTotal(hint));
}

function cloudSet(pool: readonly CandidateRow[]): Set<string> {
	const out = new Set<string>();
	for (const c of pool) if (c.kind === "cloud") out.add(c.group);
	return out;
}

/** The W136 escalation law (§5.2), all conditions AND-ed: cloud rungs of
 *  the ladder fire only when the owner switch allows, cost mode isn't
 *  active, the tier warrants (COMPLEX+ or quality mode), and local delivery
 *  already failed twice (primary + one bounded fallback attempted). */
export function mayEscalate(args: {
	group: string;
	tier?: string;
	attempts: number;
	prefs: Prefs;
	cloudGroups: Set<string>;
}): boolean {
	return (
		args.cloudGroups.has(args.group) &&
		args.prefs.allow_cloud === true &&
		args.prefs.cost_speed !== "cost" &&
		(args.tier === "COMPLEX" ||
			args.tier === "VERY_COMPLEX" ||
			args.prefs.cost_speed === "quality") &&
		args.attempts >= 2
	);
}
