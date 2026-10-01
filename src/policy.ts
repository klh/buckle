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

export interface GatewayPolicy {
	num_retries?: number;
	allowed_fails?: number;
	cooldown_time?: number;
	fallbacks?: Record<string, string[]>;
	// buckle extension knobs (belt ignores unknown keys — shared file stays
	// compatible): backoff cap for absent retry-after, per-attempt timeout.
	retry_max_delay_s?: number;
	request_timeout_s?: number;
}

interface PolicyDoc {
	version?: number;
	gateway?: GatewayPolicy;
}

/** Native-free defaults; the committed YAML carries the same values. */
export const POLICY_DEFAULTS: Required<
	Omit<GatewayPolicy, "fallbacks" | "retry_max_delay_s" | "request_timeout_s">
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

/** Parse a policy document (tests + loader share this path). */
export function parsePolicy(text: string): GatewayPolicy {
	const doc = YAML.parse(text) as PolicyDoc | null;
	const gateway = doc?.gateway ?? {};
	return { ...POLICY_DEFAULTS, ...gateway };
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
