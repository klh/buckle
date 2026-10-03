// src/lane-wrap.ts — W2 caveman adopt 2: ephemeral config-file injection for
// codex-class lanes. buildWrap() is a pure plan; materializeWrap() writes the
// temp config home (dir 0700, file 0600) the recipe's `configHomeEnv` points
// at. The user's real config is never read or mutated by the lane path —
// self-contained configs by design (deep-merging the user's TOML needs a
// parser dep; deliberate non-goal here). Rendered configs reference secrets
// by env name only (`env_key = "LITELLM_KEY"`), never values — codex reads
// the env itself. Persistent enable stays the explicit onboard step
// (bin/onboard.ts configEdit); the temp home is cleaned by the launcher
// (bin/lane-wrap.ts --run wires cleanup to child exit).

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL, type AgentRecipe } from "./agents.ts";

/** Everything needed to inject one agent's config ephemerally. */
export interface WrapPlan {
	/** recipe id, used in the temp-dir name for post-mortem readability */
	id: string;
	/** env var that redirects the agent's config home (e.g. CODEX_HOME) */
	configHomeEnv: string;
	/** config file name inside the temp home (e.g. config.toml) */
	file: string;
	/** rendered config text — secret references only, never values */
	configText: string;
}

/** Pure: recipe + gateway base → injection plan. Null for recipes without
 *  an `ephemeral` block (pure-env recipes like claude/copilot don't wrap). */
export const buildWrap = (
	recipe: AgentRecipe,
	baseUrl: string,
	model: string = DEFAULT_MODEL,
): WrapPlan | null => {
	const eph = recipe.ephemeral;
	if (!eph) return null;
	return {
		id: recipe.id,
		configHomeEnv: recipe.ephemeral?.configHomeEnv ?? "",
		file: recipe.ephemeral?.file ?? "",
		configText: eph.render(baseUrl, model),
	};
};

/** A materialized temp config home + the child-env additions that point the
 *  agent at it. `cleanup()` removes the home; the launcher owns when. */
export interface WrapHome {
	home: string;
	env: Record<string, string>;
	cleanup: () => void;
}

/** Write the plan to a fresh temp config home. Dir 0700, file 0600 (chmod
 *  after write — umask can mask the write mode). Fails closed: any error
 *  propagates; a lane never launches half-injected. */
export const materializeWrap = (plan: WrapPlan): WrapHome => {
	const home = mkdtempSync(join(tmpdir(), `buckle-wrap-${plan.id}-`));
	chmodSync(home, 0o700);
	const file = join(home, plan.file);
	writeFileSync(file, plan.configText, { mode: 0o600 });
	chmodSync(file, 0o600);
	return {
		home,
		env: { [plan.configHomeEnv]: home },
		cleanup: () => rmSync(home, { recursive: true, force: true }),
	};
};
