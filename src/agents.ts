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
					`wire_api = "chat"`,
				].join("\n")}\n`,
			},
		},
		probe: { kind: "http", url: `${baseUrl}/models` },
		notes:
			"provider block in ~/.codex/config.toml + OPENAI_BASE_URL for the env-only path",
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
