// src/policy.ts — port of belt bin/router-policy.ts (W124): same YAML, same
// runtime override chain. The single policy source is routing-policy.yaml
// (committed default, identical data to belt's); a runtime copy at
// ~/.claude/local-llm/routing-policy.yaml overrides it, and BUCKLE_POLICY /
// BELT_POLICY override both. Operators edit the YAML, never code.
//
// Everything the policy expresses is native-router behavior ported from
// LiteLLM 1.103.0 (MIT; pinned-source verified W126/W129): fallbacks =
// ordered cross-group ladders tried after num_retries per tier; allowed_fails
// + cooldown_time = passive outlier ejection; num_retries = per-tier retries
// whose backoff honors the upstream retry-after header with jitter
// (utils.py::_calculate_retry_after semantics).
import { YAML } from "bun";
import { existsSync, readFileSync } from "node:fs";

/** OWNER DIRECTIVE (W124, lesson.fanout-rate-budget): flashx appears in no
 *  group, no ladder, no alias — same upstream family saturates together and
 *  the tier is too expensive. Enforced structurally: the ladder walk refuses
 *  flashx tiers and the candidate table never builds flashx rows. */
export const FLASHX = /flashx/i;

export interface GatewayPolicy {
	num_retries?: number;
	allowed_fails?: number;
	cooldown_time?: number;
	fallbacks?: Record<string, string[]>;
	// W136 routing laws §3.2: per-group capability tags — the string the hint
	// tag cloud regexps against. Operators edit the YAML, never code; absent
	// tags contribute no text (the file stays v1-compatible).
	tags?: Record<string, string[]>;
	// buckle extension knobs (belt ignores unknown keys — shared file stays
	// compatible): backoff cap for absent retry-after, per-attempt timeout.
	retry_max_delay_s?: number;
	request_timeout_s?: number;
	// W142 knowledge-aids policy (buckle enforcement, belt ignores): the
	// preseed allowlist is the operator's on-switch per domain; compress is
	// DEFAULT-OFF per the W137 economics (cache reads are 0.1x — compression
	// must prove ROI on cache-miss traffic before an operator flips it).
	aids?: AidsPolicy;
}

/** W142 aids policy (routing-policy.yaml `aids:` block). Belt ignores the
 *  block; buckle refuses what policy forbids with an honest skip. */
export interface AidsPolicy {
	preseed?: {
		default?: "on" | "off";
		domains?: string[];
		ttl_s?: number;
		knowledge_url?: string;
	};
	"cache-align"?: { default?: "on" | "off" };
	compress?: { default?: "on" | "off"; max_prose_bytes?: number };
	// W4 expand (W288 retarget): orchestrate-enhance declares `expand` — the
	// user goal is expanded with an architectural-wants digest (fleet laws +
	// repo conventions) by the LOCAL DIRECT tier, one candidate, no ladder
	// walk, never a cloud row. DEFAULT-OFF per the W137 economics law: an
	// extra LLM hop proves ROI before operators flip it onto the path.
	expand?: {
		default?: "on" | "off";
		group?: string; // the local direct tier; default local-swarm
		timeout_ms?: number;
		max_goal_chars?: number;
		max_digest_bytes?: number;
	};
	/** W5 prompt pipeline IN: the response-side condense is sideband-only
	 *  (served bytes never change), so declarations are honored by default;
	 *  `default: "off"` is the operator kill switch. */
	"condense-in"?: { default?: "on" | "off"; max_bytes?: number };
}

interface PolicyDoc {
	version?: number;
	gateway?: GatewayPolicy;
	tags?: Record<string, string[]>;
	aids?: AidsPolicy;
}

/** Native-free defaults; the committed YAML carries the same values. */
export const POLICY_DEFAULTS: Required<
	Omit<
		GatewayPolicy,
		"fallbacks" | "tags" | "retry_max_delay_s" | "request_timeout_s" | "aids"
	>
> & {
	retry_max_delay_s: number;
	request_timeout_s: number;
} = {
	num_retries: 1,
	allowed_fails: 3,
	cooldown_time: 30,
	retry_max_delay_s: 8,
	request_timeout_s: 120,
};

/** Parse a policy file: gateway knobs + the W136 tags block. */
export function parsePolicy(text: string): GatewayPolicy {
	const doc = YAML.parse(text) as PolicyDoc | null;
	const gateway = doc?.gateway ?? {};
	return {
		...POLICY_DEFAULTS,
		...gateway,
		tags: doc?.tags ?? {},
		aids: doc?.aids ?? {},
	};
}

/** Resolution order: explicit path → BUCKLE_POLICY → BELT_POLICY → runtime
 *  copy in the local-llm dir → the committed default in the repo root. */
export function loadGatewayPolicy(explicitPath?: string): GatewayPolicy {
	const candidates = [
		explicitPath,
		process.env.BUCKLE_POLICY,
		process.env.BELT_POLICY,
		`${process.env.HOME}/.claude/local-llm/routing-policy.yaml`,
		new URL("../routing-policy.yaml", import.meta.url).pathname,
	].filter((p): p is string => typeof p === "string" && p.length > 0);
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		return parsePolicy(readFileSync(p, "utf8"));
	}
	throw new Error(
		"policy: no routing-policy.yaml (BUCKLE_POLICY/BELT_POLICY, ~/.claude/local-llm/, repo root)",
	);
}

// ─── prefs: allow_cloud / cost_speed, the owner's escalation switches ───
// Belt's prefs.json (bin/router-shim.ts) is the file this machine already
// runs; defaults are conservative: cloud off, balanced.
export interface Prefs {
	cost_speed: "balanced" | "cost" | "speed" | "quality";
	allow_cloud: boolean;
}

export const PREFS_DEFAULTS: Prefs = {
	cost_speed: "balanced",
	allow_cloud: false,
};

/** Prefs resolution: explicit path → BUCKLE_PREFS → the belt prefs file.
 *  Missing/unreadable file → defaults (loading never throws). */
export function loadPrefs(explicitPath?: string): Prefs {
	const p =
		explicitPath ??
		process.env.BUCKLE_PREFS ??
		`${process.env.HOME}/.claude/local-llm/prefs.json`;
	try {
		const doc = JSON.parse(readFileSync(p, "utf8")) as Partial<Prefs>;
		const cs = doc.cost_speed;
		return {
			cost_speed:
				cs !== undefined &&
				(["balanced", "cost", "speed", "quality"] as const).includes(cs)
					? cs
					: PREFS_DEFAULTS.cost_speed,
			allow_cloud: doc.allow_cloud === true,
		} satisfies Prefs;
	} catch {
		return { ...PREFS_DEFAULTS };
	}
}
