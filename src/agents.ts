// src/agents.ts — W227-A3: agents are rows, not code. Each coding agent the
// onboarding CLI can wire to buckle is an AgentRecipe row: detect signals,
// wire dialect, reroute moves (env exports and/or a config-file edit) and a
// local-only probe. The full table lands in docs/agent-recipes-draft.md
// (W227-A2); this seed of 3 verified entries keeps the interface stable.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One coding agent, fully described as data (W227-A3 interface — stable;
 *  the A2 draft table grows against exactly this shape). */
export interface AgentRecipe {
	id: string;
	label: string;
	detect: { bin?: string; configDir?: string; configFiles?: string[] };
	wire: "openai" | "anthropic" | "azure" | "gemini";
	reroute: {
		env?: Record<string, string>;
		configEdit?: {
			file: string;
			kind: "toml" | "json" | "yaml" | "props";
			anchor: string;
			value: string;
		};
	};
	/** W2 caveman adopt 2: ephemeral config-home injection for lanes — the
	 *  rendered config lands in a temp home (dir 0700, file 0600) pointed at
	 *  via `configHomeEnv`; the user's real config is never mutated and the
	 *  persistent enable stays the onboard configEdit path above. Rendered
	 *  configs reference secrets by env name only, never values. */
	ephemeral?: {
		configHomeEnv: string;
		file: string;
		render: (baseUrl: string, model: string) => string;
	};
	probe:
		| { kind: "cli"; argv: string[]; expect: string }
		| { kind: "http"; url: string };
	notes?: string;
}

/** Detection result for one recipe — read-only signals, no side effects. */
export interface DetectedAgent {
	recipe: AgentRecipe;
	/** at least one detect signal fired (bin on PATH or config on disk) */
	detected: boolean;
	/** human-readable signals, e.g. "bin claude on PATH" */
	signals: string[];
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:4100/v1";
export const DEFAULT_MODEL = "claude-sonnet-5";

/** The anthropic dialect takes the server root — clients append
 *  /v1/messages; the openai dialect takes the full base incl. /v1. */
export const anthropicRoot = (baseUrl: string): string =>
	baseUrl.replace(/\/v1\/?$/, "");

/** Expand a leading `~` to the user's home dir. */
export const expandPath = (p: string): string =>
	p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;

/** W1 lane attribution (caveman adopt 1): the base-URL union for one lane —
 *  every base-URL var an executor might honor points at the front's
 *  `/w/<slug>` attribution prefix, so the board gets executor↔model↔lane
 *  joins from the path alone. Dialect asymmetry per agent-recipes-draft.md:
 *  openai-family bases include /v1 (clients append /chat/completions);
 *  anthropic/gemini roots don't (clients append /v1/messages). The dispatch
 *  side calls this with the buckle front, e.g.
 *  `laneEnv(sid, "http://127.0.0.1:4101/v1")`. Slugs: [A-Za-z0-9][A-Za-z0-9._-]*. */
export const laneEnv = (
	slug: string,
	baseUrl: string = DEFAULT_BASE_URL,
): Record<string, string> => {
	const laneRoot = `${anthropicRoot(baseUrl)}/w/${slug}`;
	return {
		ANTHROPIC_BASE_URL: laneRoot,
		OPENAI_BASE_URL: `${laneRoot}/v1`,
		OPENAI_API_BASE: `${laneRoot}/v1`,
		GOOGLE_GEMINI_BASE_URL: laneRoot,
	};
};

/** The seed table. `baseUrl` is the openai-dialect base (…/v1); anthropic
 *  entries derive their root from it. */
export const agentRecipes = (
	baseUrl: string = DEFAULT_BASE_URL,
): AgentRecipe[] => [
	{
		id: "claude",
		label: "claude code",
		detect: { bin: "claude", configDir: "~/.claude" },
		wire: "anthropic",
		reroute: {
			env: {
				ANTHROPIC_BASE_URL: anthropicRoot(baseUrl),
				ANTHROPIC_MODEL: DEFAULT_MODEL,
			},
		},
		probe: { kind: "http", url: `${anthropicRoot(baseUrl)}/v1/messages` },
		notes: "pure env reroute — unset ANTHROPIC_BASE_URL to return to the cloud",
	},
	{
		id: "codex",
		label: "codex",
		detect: {
			bin: "codex",
			configDir: "~/.codex",
			configFiles: ["~/.codex/config.toml"],
		},
		wire: "openai",
		reroute: {
			env: { OPENAI_BASE_URL: baseUrl },
			configEdit: {
				file: "~/.codex/config.toml",
				kind: "toml",
				anchor: "[model_providers.buckle]",
				value: `${[
					"[model_providers.buckle]",
					`name = "buckle"`,
					`base_url = "${baseUrl}"`,
					`env_key = "LITELLM_KEY"`,
					`wire_api = "responses"`,
				].join("\n")}\n`,
			},
		},
		// benchmarks.md codex row (PASS 2026-10-03): temp CODEX_HOME +
		// wire_api="responses" + env_key reaches :4100. codex >=0.158
		// hard-errors on wire_api="chat" — responses is the only wire.
		ephemeral: {
			configHomeEnv: "CODEX_HOME",
			file: "config.toml",
			render: (baseUrl, model) =>
				`${[
					`model = "${model}"`,
					`model_provider = "buckle"`,
					"",
					"[model_providers.buckle]",
					`name = "buckle"`,
					`base_url = "${baseUrl}"`,
					`env_key = "LITELLM_KEY"`,
					`wire_api = "responses"`,
				].join("\n")}\n`,
		},
		probe: { kind: "http", url: `${baseUrl}/models` },
		notes:
			"ephemeral lane path = temp CODEX_HOME (bin/lane-wrap.ts); persistent enable = the configEdit block (responses wire only since codex 0.158)",
	},
	{
		id: "copilot",
		label: "github copilot cli",
		detect: { bin: "copilot", configDir: "~/.copilot" },
		wire: "openai",
		reroute: {
			env: {
				COPILOT_PROVIDER_BASE_URL: baseUrl,
				COPILOT_PROVIDER_TYPE: "openai",
				COPILOT_MODEL: DEFAULT_MODEL,
			},
		},
		probe: { kind: "http", url: `${baseUrl}/models` },
		notes: "pure env reroute — nothing on disk",
	},
];

/** Read-only detection: bin-on-PATH (Bun.which) + config existence. No
 *  network, no writes. */
export const detectAgents = (
	recipes: AgentRecipe[] = agentRecipes(),
): DetectedAgent[] =>
	recipes.map((recipe) => {
		const signals: string[] = [];
		const bin = recipe.detect.bin;
		if (bin && Bun.which(bin) !== null) signals.push(`bin ${bin} on PATH`);
		const dir = recipe.detect.configDir;
		if (dir && existsSync(expandPath(dir))) signals.push(`${dir} exists`);
		for (const file of recipe.detect.configFiles ?? []) {
			if (existsSync(expandPath(file))) signals.push(`${file} exists`);
		}
		return { recipe, detected: signals.length > 0, signals };
	});
