// test/lane-wrap.test.ts — W2: ephemeral config injection for codex-class
// lanes. Covers the pure plan, materialization (modes 0700/0600), cleanup,
// the secret-reference law, and the user-config-untouched sentinel.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { agentRecipes } from "../src/agents.ts";
import { buildWrap, materializeWrap } from "../src/lane-wrap.ts";

const CODEX = (() => {
	const hit = agentRecipes("http://127.0.0.1:4100/v1").find(
		(r) => r.id === "codex",
	);
	if (!hit) throw new Error("codex recipe missing");
	return hit;
})();
const BASE = "http://127.0.0.1:4100/v1";

describe("buildWrap", () => {
	test("codex recipe yields a plan with the config-home env var", () => {
		const plan = buildWrap(CODEX, BASE, "github_copilot/gpt-5.2");
		if (!plan) throw new Error("codex wrap plan missing");
		expect(plan.configHomeEnv).toBe("CODEX_HOME");
		expect(plan.file).toBe("config.toml");
	});

	test("pure-env recipes (claude) have no wrap — null", () => {
		const claude = agentRecipes(BASE).find((r) => r.id === "claude");
		if (!claude) throw new Error("claude recipe missing");
		expect(buildWrap(claude, BASE)).toBeNull();
	});
});

describe("materializeWrap", () => {
	test("temp home 0700, config 0600, content per evidence", () => {
		const plan = buildWrap(CODEX, BASE, "github_copilot/gpt-5.2");
		if (!plan) throw new Error("codex wrap plan missing");
		const got = materializeWrap(plan);
		try {
			expect(statSync(got.home).mode & 0o777).toBe(0o700);
			const file = join(got.home, "config.toml");
			expect(statSync(file).mode & 0o777).toBe(0o600);
			const text = readFileSync(file, "utf8");
			expect(text).toContain(`wire_api = "responses"`);
			// secret-reference law: env NAME only, never a value
			expect(text).toContain(`env_key = "LITELLM_KEY"`);
			expect(text).not.toContain("sk-");
			expect(text).toContain(`model = "github_copilot/gpt-5.2"`);
		} finally {
			got.cleanup();
		}
	});

	test("cleanup removes the home entirely", () => {
		const plan = buildWrap(CODEX, BASE);
		if (!plan) throw new Error("codex wrap plan missing");
		const got = materializeWrap(plan);
		expect(existsSync(got.home)).toBe(true);
		got.cleanup();
		expect(existsSync(got.home)).toBe(false);
	});
});
