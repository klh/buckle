// src/hints.ts — the W96 hint grammar, ported verbatim from belt
// bin/route-policy.ts (parseHint/hintFit/hintTotal, commit 5ec7b90) plus the
// W136 wire addition: hints ride in the x-belt-hint request header (≤512
// chars), and a duplicate header is refused, not resolved silently.
//
// hint := VERB LOCATION? MODEL? TAGS*
//   VERB     := prefer | must
//   LOCATION := local | cloud | host:<server>
//   MODEL    := model:<id-or-glob>   ('*' wildcard, case-insensitive)
//   TAGS     := tag+                 (each tag is a regexp)
//
// Zero LLM, zero network: pure regexps and token walks (W136 law 1).
// Rejection is a product surface — every refusal carries a why naming the
// first fault (belt's messages kept verbatim).

export interface RouteHint {
	verb: "prefer" | "must";
	// local/cloud or a set host — absent = every machine qualifies
	location?: { kind: "local" | "cloud" } | { host: string };
	model?: string; // glob: '*' wildcard, case-insensitive
	tags: string[]; // regexp sources, OR-semantics
}

const HINT_TOKENS_MAX = 12;
const HINT_TOKEN_MAX = 64;
const HINT_RAW_MAX = 512; // W136: the header addition

export type ParsedHint =
	| { ok: true; hint: RouteHint }
	| { ok: false; why: string };

/** Parse 'must cloud', 'prefer local distill reasoning',
 *  'prefer host:nas model:qwen*' — malformed input is a rejection with the
 *  reason, never a guess. */
export function parseHint(raw: string): ParsedHint {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	if (!tokens.length || tokens.length > HINT_TOKENS_MAX)
		return {
			ok: false,
			why: `hint: 1–${HINT_TOKENS_MAX} whitespace-separated tokens, e.g. 'prefer local reasoning'`,
		};
	const [verb, ...rest] = tokens;
	if (!verb) return { ok: false, why: "hint: no tokens" }; // unreachable (length checked)
	if (verb !== "prefer" && verb !== "must")
		return {
			ok: false,
			why: `hint must start with 'prefer' or 'must', got '${verb.slice(0, 24)}'`,
		};
	const hint: RouteHint = { verb, tags: [] };
	return finishHint(hint, rest);
}

/** Token loop, split out to keep each mutation small (belt structure). */
function finishHint(hint: RouteHint, rest: string[]): ParsedHint {
	for (const tok of rest) {
		if (tok.length > HINT_TOKEN_MAX)
			return {
				ok: false,
				why: `hint token over ${HINT_TOKEN_MAX} chars: '${tok.slice(0, 24)}…'`,
			};
		if (tok === "local" || tok === "cloud") {
			if (hint.location)
				return { ok: false, why: `hint: duplicate location ('${tok}')` };
			hint.location = { kind: tok };
		} else if (tok.startsWith("host:")) {
			if (hint.location)
				return { ok: false, why: `hint: duplicate location ('${tok}')` };
			const host = tok.slice("host:".length);
			if (!host) return { ok: false, why: "hint: host: needs a server name" };
			hint.location = { host };
		} else if (tok.startsWith("model:")) {
			if (hint.model) return { ok: false, why: "hint: duplicate model:" };
			const model = tok.slice("model:".length);
			if (!model) return { ok: false, why: "hint: model: needs an id or glob" };
			hint.model = model;
		} else {
			hint.tags.push(tok);
		}
	}
	return { ok: true, hint };
}

// ─── regexp helpers (belt verbatim + per-source caches) ───
const RE_META = new Set("\\.*+?^$()[]{}|/".split(""));

/** Escape every regexp metachar in s. */
const escapeRe = (s: string): string =>
	s
		.split("")
		.map((ch) => (RE_META.has(ch) ? `\\${ch}` : ch))
		.join("");

const GLOB_CACHE = new Map<string, RegExp>();
const TAG_CACHE = new Map<string, RegExp>();
const RE_CACHE_MAX = 512;

/** Glob → regexp matched anywhere in the model id, case-insensitive —
 *  ids carry namespace prefixes (mlx-community/Qwen3.5-…), so qwen* means
 *  'any qwen anywhere in the id'; only '*' is special. Cached per source. */
const globToRe = (glob: string): RegExp => {
	const hit = GLOB_CACHE.get(glob);
	if (hit) return hit;
	const esc = glob
		.split("")
		.map((ch) => (ch === "*" ? ".*" : escapeRe(ch)))
		.join("");
	const re = new RegExp(esc, "i");
	if (GLOB_CACHE.size >= RE_CACHE_MAX) GLOB_CACHE.clear();
	GLOB_CACHE.set(glob, re);
	return re;
};

/** Tag cloud entry → regexp; a non-compiling tag degrades to a literal
 *  substring test — deterministic, never throws. Cached per source, so
 *  steady-state decisions compile nothing (W136 §2). */
const tagRe = (tag: string): RegExp => {
	const hit = TAG_CACHE.get(tag);
	if (hit) return hit;
	let re: RegExp;
	try {
		re = new RegExp(tag, "i");
	} catch {
		re = new RegExp(escapeRe(tag), "i");
	}
	if (TAG_CACHE.size >= RE_CACHE_MAX) TAG_CACHE.clear();
	TAG_CACHE.set(tag, re);
	return re;
};

/** Policy regeneration hook: drop compiled tag regexps (W136 §3.2). */
export function resetHintCaches(): void {
	TAG_CACHE.clear();
	GLOB_CACHE.clear();
}

// ─── fit (W96 semantics, belt verbatim) ───
export interface FitInput {
	kind: string;
	machine: string;
	model: string;
	tags: string; // the candidate's capability text
}

/** How many of the hint's present groups does the candidate satisfy?
 *  location + model + tag cloud (any one tag); absent groups never count. */
export function hintFit(c: FitInput, h: RouteHint): number {
	let tier = 0;
	if (h.location) {
		const ok =
			"kind" in h.location
				? c.kind === h.location.kind
				: c.machine.toLowerCase() === h.location.host.toLowerCase();
		if (ok) tier++;
	}
	if (h.model && globToRe(h.model).test(c.model)) tier++;
	if (h.tags.length && h.tags.some((t) => tagRe(t).test(c.tags))) tier++;
	return tier;
}

/** Full-fit threshold — the count of groups the hint actually carries. */
export const hintTotal = (h: RouteHint): number =>
	(h.location ? 1 : 0) + (h.model ? 1 : 0) + (h.tags.length ? 1 : 0);

// ─── the wire seam: x-belt-hint request header (W136 §1) ───
const HINT_HEADER = "x-belt-hint";
// Bun joins duplicate request headers with ', ' — a second verb after a
// comma is the duplicate-header signature. A single hint can only hit this
// if it embeds ', prefer/must …' — itself two glued hints, i.e. genuinely
// ambiguous input; refusing ambiguity is the same trust class as the
// duplicate-location rejection.
const DUP_HEADER = /,\s*(?:prefer|must)\b/;

export type HintRead =
	| { ok: true; raw: string; hint: RouteHint | null }
	| { ok: false; why: string };

/** Read the hint from request headers. Absent or empty header = no hint;
 *  >512-char header, a duplicate-header signature, or a grammar fault is a
 *  bad_hint rejection with the first fault named. */
export function hintFromHeaders(h: Headers): HintRead {
	const raw = h.get(HINT_HEADER);
	if (raw === null) return { ok: true, raw: "", hint: null };
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { ok: true, raw: "", hint: null };
	if (raw.length > HINT_RAW_MAX)
		return {
			ok: false,
			why: `hint: header over ${HINT_RAW_MAX} chars (got ${String(raw.length)})`,
		};
	if (DUP_HEADER.test(raw))
		return { ok: false, why: "exactly one x-belt-hint header allowed" };
	const parsed = parseHint(trimmed);
	if (!parsed.ok) return parsed;
	return { ok: true, raw: trimmed, hint: parsed.hint };
}
