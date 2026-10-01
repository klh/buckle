// test/policy.test.ts — parse + defaults for the W124 policy shape.
import { expect, test } from "bun:test";
import { POLICY_DEFAULTS, parsePolicy } from "../src/policy.ts";

test("parsePolicy: defaults when gateway section absent", () => {
	const p = parsePolicy("version: 1\n");
	expect(p.num_retries).toBe(1);
	expect(p.allowed_fails).toBe(3);
	expect(p.cooldown_time).toBe(30);
	expect(p.retry_max_delay_s).toBe(8);
	expect(p.request_timeout_s).toBe(120);
	expect(p.fallbacks).toBeUndefined();
});

test("parsePolicy: W124 ladder verbatim", () => {
	const yaml =
		"gateway:\n  fallbacks:\n    glm-5.3-flash: [local-swarm, gpt-5.2, claude-sonnet-5]\n";
	const p = parsePolicy(yaml);
	const ladder = p.fallbacks ? p.fallbacks["glm-5.3-flash"] : undefined;
	expect(ladder).toEqual(["local-swarm", "gpt-5.2", "claude-sonnet-5"]);
});

test("parsePolicy: buckle knobs survive the shared-file shape", () => {
	const p = parsePolicy(
		"gateway:\n  retry_max_delay_s: 4\n  request_timeout_s: 60\n",
	);
	expect(p.retry_max_delay_s).toBe(4);
	expect(p.request_timeout_s).toBe(60);
});

test("POLICY_DEFAULTS: fixed constants from the ported semantics", () => {
	expect(POLICY_DEFAULTS).toEqual({
		num_retries: 1,
		allowed_fails: 3,
		cooldown_time: 30,
		retry_max_delay_s: 8,
		request_timeout_s: 120,
	});
});
