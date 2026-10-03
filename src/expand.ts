// src/expand.ts — W4 intent expansion on the prompt pipeline OUT. Belt's
// orchestrate-enhance declares `expand` in the aids stanza; buckle
// retargets the enhancement to the LOCAL DIRECT tier (the W288 fix — one
// candidate, no ladder walk, never a cloud row) and expands the user goal
// with an architectural-wants digest (fleet laws + repo conventions) via
// that local LLM. Opt-in DEFAULT-OFF (routing-policy.yaml aids.expand);
// aids-are-garnish holds — every failure is an honest, metered skip and an
// outage never blocks a dispatch.
import type { CandidateRow } from "./candidates.ts";
import { compareCandidates } from "./decide.ts";
import type { AidsPolicy } from "./policy.ts";
import type { Dialect } from "./upstreams.ts";

type AnyRec = Record<string, unknown>;

/** Wire-format defaults; the routing-policy.yaml stanza overrides. */
export const EXPAND_DEFAULTS = {
	group: "local-swarm",
	timeout_ms: 3000,
	max_goal_chars: 4000,
	max_digest_bytes: 2048,
} as const;

/** The goal rides in the LAST user message (string or block array), capped
 *  at max. Empty when no user message carries text. */
export function goalFromMessages(messages: unknown, max: number): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as AnyRec | null;
		if (m?.role !== "user") continue;
		let text = "";
		const content = m.content;
		if (typeof content === "string") {
			text = content;
		} else if (Array.isArray(content)) {
			const parts: string[] = [];
			for (const b of content) {
				const t = (b as AnyRec | null)?.text;
				if (typeof t === "string") parts.push(t);
			}
			text = parts.join(" ");
		}
		const trimmed = text.trim();
		if (trimmed.length > 0) return trimmed.slice(0, max);
		// an empty trailing user message: walk further back
	}
	return "";
}

/** System prompt for the expansion call. Deterministic bytes. */
export const EXPAND_SYSTEM =
	"You expand a coding agent's task goal into an architectural-wants digest: " +
	"the concrete structural wants implied by the goal (modules, seams, invariants, " +
	"interfaces), the applicable fleet laws it touches (routing, aids, ownership, " +
	"pass-through), and the repo conventions it must honor. Output ONLY the digest " +
	"as terse bullets, no preamble, no markdown fences.";

/** Deterministic openai-wire body for the direct call: non-stream,
 *  temperature 0, the direct tier's own wire id. */
export function expansionBody(
	goal: string,
	context: string,
	model: string,
): AnyRec {
	const ctx = context.trim();
	const user = ctx
		? `${goal}\n\n[fleet context — laws + conventions]\n${ctx}`
		: goal;
	return {
		model,
		stream: false,
		temperature: 0,
		max_tokens: 400,
		messages: [
			{ role: "system", content: EXPAND_SYSTEM },
			{ role: "user", content: user },
		],
	};
}

/** The expansion context is the request's system text (belt's brief
 *  preamble — fleet laws + repo conventions live there). */
export function contextOf(body: AnyRec): string {
	const parts: string[] = [];
	const sys = body.system;
	if (typeof sys === "string") parts.push(sys);
	else if (Array.isArray(sys)) {
		for (const b of sys) {
			const t = (b as AnyRec | null)?.text;
			if (typeof t === "string") parts.push(t);
		}
	}
	if (Array.isArray(body.messages)) {
		for (const m of body.messages) {
			if ((m as AnyRec | null)?.role !== "system") continue;
			const content = (m as AnyRec).content;
			if (typeof content === "string") parts.push(content);
		}
	}
	return parts.join("\n\n");
}

/** Cap text to max bytes (char-slice then byte-check shrink loop). */
export function capBytes(text: string, max: number): string {
	let s = text.slice(0, max);
	while (Buffer.byteLength(s) > max) s = s.slice(0, Math.floor(s.length * 0.9));
	return s;
}

/** Prepend the digest to the outbound prompt (pipeline OUT). OpenAI rides a
 *  leading system message; anthropic prepends to the system field. The
 *  header is deterministic — served_model is METERED, never injected, so
 *  stable bytes still ride provider KV caches. */
export function injectDigest(
	body: AnyRec,
	dialect: Dialect,
	digest: string,
): void {
	const block = `[intent expansion · architectural-wants digest]\n${digest}`;
	if (dialect === "openai") {
		const msgs = Array.isArray(body.messages) ? body.messages : [];
		msgs.unshift({ role: "system", content: block });
		body.messages = msgs;
		return;
	}
	const sys = body.system;
	if (typeof sys === "string") body.system = `${block}\n${sys}`;
	else if (Array.isArray(sys)) sys.unshift({ type: "text", text: block });
	else body.system = block;
}

/** ONE healthy local candidate from the direct tier — the structural
 *  retarget law: expansion never rides a cloud row, whatever prefs say. */
export function pickLocalDirect(
	candidates: readonly CandidateRow[],
	group: string,
): CandidateRow | null {
	const rows = candidates
		.filter((c) => c.group === group && c.kind === "local" && c.healthy)
		.sort(compareCandidates);
	return rows[0] ?? null;
}

/** The real direct call: one POST to the candidate's deployment — openai
 *  chat-completions wire, non-stream, aborts at timeoutMs. Any non-ok
 *  status or unparseable body throws (the caller meters an honest skip). */
export async function directCall(
	row: CandidateRow,
	body: AnyRec,
	timeoutMs: number,
): Promise<string> {
	const keyEnv = row.dep.api_key_env;
	const res = await fetch(`${row.dep.url}/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(keyEnv
				? { authorization: `Bearer ${process.env[keyEnv] ?? ""}` }
				: {}),
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) throw new Error(`expand: direct tier ${String(res.status)}`);
	const parsed = (await res.json()) as AnyRec;
	const msg = (parsed.choices as AnyRec[] | undefined)?.[0]?.message;
	const text = (msg as AnyRec | undefined)?.content;
	if (typeof text !== "string") throw new Error("expand: no content");
	return text;
}

/** One expansion request (endpoint shape). */
export interface ExpandRequest {
	goal: string;
	context?: string;
	sid?: string | null;
	work_item?: string | null;
}

/** Returned for the CALLER to meter (the preseed pattern: the engine stays
 *  metering-free; one metering site per call site). */
export interface ExpandOutcome {
	decision: "injected" | "skipped";
	skip_reason?: "policy" | "invalid" | "no-local" | "outage";
	digest?: string;
	served_model?: string;
	bytes?: number;
}

export interface ExpandDeps {
	policy: AidsPolicy;
	/** ONE healthy local candidate from the direct tier. */
	pick: (group: string) => CandidateRow | null;
	/** One direct call, timeout-bounded by the implementation. */
	call: (row: CandidateRow, body: AnyRec, timeoutMs: number) => Promise<string>;
}

/** The intent-expansion engine. Policy-gated (default OFF), structurally
 *  local (pick returns null rather than a cloud row), garnish-legal. */
export class Expander {
	constructor(private readonly deps: ExpandDeps) {}

	private get cfg() {
		return { ...EXPAND_DEFAULTS, ...(this.deps.policy.expand ?? {}) };
	}

	/** Policy gate: absent stanza = OFF (the opt-in law). */
	on(): boolean {
		return this.deps.policy.expand?.default === "on";
	}

	/** Expand one goal. Skip reasons are honest: policy (gate closed),
	 *  invalid (no goal text), no-local (the direct tier is empty/down),
	 *  outage (the direct call failed or timed out). */
	async expand(req: ExpandRequest): Promise<ExpandOutcome> {
		if (!this.on()) return { decision: "skipped", skip_reason: "policy" };
		const cfg = this.cfg;
		const goal = (req.goal ?? "").trim().slice(0, cfg.max_goal_chars);
		if (!goal) return { decision: "skipped", skip_reason: "invalid" };
		const row = this.deps.pick(cfg.group);
		if (!row) return { decision: "skipped", skip_reason: "no-local" };
		let text: string;
		try {
			text = await this.deps.call(
				row,
				expansionBody(goal, req.context ?? "", row.model),
				cfg.timeout_ms,
			);
		} catch {
			return { decision: "skipped", skip_reason: "outage" };
		}
		const digest = capBytes(text.trim(), cfg.max_digest_bytes);
		if (!digest) return { decision: "skipped", skip_reason: "outage" };
		return {
			decision: "injected",
			digest,
			served_model: row.model,
			bytes: Buffer.byteLength(digest),
		};
	}

	/** Wire shape: goal + context extracted from the request body, the
	 *  digest injected back on success (the body mutates in place — the
	 *  expanded prompt is what rides OUT toward the upstream). */
	async expandBody(body: AnyRec, dialect: Dialect): Promise<ExpandOutcome> {
		const cfg = this.cfg;
		const outcome = await this.expand({
			goal: goalFromMessages(body.messages, cfg.max_goal_chars),
			context: contextOf(body),
		});
		if (outcome.decision === "injected" && outcome.digest) {
			injectDigest(body, dialect, outcome.digest);
		}
		return outcome;
	}
}
