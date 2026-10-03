// bin/lane-wrap.ts — W2: launch a coding-agent lane with an ephemeral config
// home (caveman adopt 2). The agent's real config is never touched; the temp
// home (dir 0700, file 0600) carries only env-name secret references, never
// values. Persistent enable stays bin/onboard.ts's explicit step.
//
//	bun bin/lane-wrap.ts codex [--base-url URL] [--model M] [--dry-run]
//	bun bin/lane-wrap.ts codex --run -- codex --version
//
// --run spawns the child with recipe env + wrap env merged, inherits stdio,
// and removes the temp home when the child exits. Without --run the plan is
// materialized and eval-able exports are printed (cleanup is then yours:
// `rm -rf <home>`).

import {
	DEFAULT_BASE_URL,
	DEFAULT_MODEL,
	agentRecipes,
} from "../src/agents.ts";
import {
	buildWrap,
	materializeWrap,
	type WrapHome,
	type WrapPlan,
} from "../src/lane-wrap.ts";
import type { AgentRecipe } from "../src/agents.ts";

const arg = (name: string): string | null => {
	const first = process.argv.indexOf(`--${name}`);
	return first >= 0 ? (process.argv[first + 1] ?? null) : null;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);
const out = (s = ""): void => process.stdout.write(`${s}\n`);
const err = (s = ""): void => process.stderr.write(`${s}\n`);

/** Resolve the recipe + wrap plan for `id`, or exit with guidance. */
const planFor = (
	id: string,
	baseUrl: string,
): { recipe: AgentRecipe; plan: WrapPlan } => {
	const all = agentRecipes(baseUrl);
	const recipe = all.find((r) => r.id === id);
	if (!recipe) {
		err(
			`lane-wrap: no recipe '${id}' — known: ${all.map((r) => r.id).join(", ")}`,
		);
		process.exit(1);
	}
	const model = arg("model") ?? DEFAULT_MODEL;
	const plan = buildWrap(recipe, baseUrl, model);
	if (!plan) {
		err(
			`lane-wrap: ${id} has no ephemeral config (pure env reroute) — export these instead:`,
		);
		for (const [k, v] of Object.entries(recipe.reroute.env ?? {})) {
			out(`export ${k}="${v}"`);
		}
		process.exit(1);
	}
	return { recipe, plan };
};

const BASE_URL = (arg("base-url") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

const usage = (): void => {
	out(
		"usage: bun bin/lane-wrap.ts <agent-id> [--base-url URL] [--model M] [--dry-run | --run -- <argv…>]",
	);
};

/** Dry-run mode: print the would-be injection, write nothing. */
const printPlan = (id: string, plan: WrapPlan): void => {
	out(`# lane-wrap ${id} — dry run, nothing written (base ${BASE_URL})`);
	out(`# ${plan.file} in $${plan.configHomeEnv}:`);
	for (const line of plan.configText.trimEnd().split("\n")) {
		out(`#   ${line}`);
	}
	out(`# child env: ${plan.configHomeEnv}=<temp home 0700>`);
};

const main = async (): Promise<number> => {
	const id = process.argv[2];
	if (has("help") || !id || id.startsWith("--")) {
		usage();
		return id && !id.startsWith("--") ? 1 : 0;
	}
	const { recipe, plan } = planFor(id, BASE_URL);
	if (has("dry-run")) {
		printPlan(id, plan);
		return 0;
	}
	const got = materializeWrap(plan);
	const childEnv: NodeJS.ProcessEnv = {
		...process.env,
		...(recipe.reroute.env ?? {}),
		...got.env,
	};
	if (!has("run")) {
		for (const [k, v] of Object.entries(got.env)) {
			out(`export ${k}="${v}"`);
		}
		out(`# temp home: ${got.home} — rm -rf it when the lane ends`);
		out("# or drive it directly: --run -- <argv…>");
		return 0;
	}
	return runChild(got, childEnv);
};

/** --run: spawn the child lane with recipe env + wrap env, clean up on exit. */
const runChild = async (
	got: WrapHome,
	childEnv: NodeJS.ProcessEnv,
): Promise<number> => {
	const sep = process.argv.indexOf("--");
	const argv = sep >= 0 ? process.argv.slice(sep + 1) : [];
	if (argv.length === 0) {
		err("lane-wrap: --run needs `-- <argv…>`");
		got.cleanup();
		return 1;
	}
	const proc = Bun.spawn(argv, {
		env: childEnv,
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
	});
	const code = await proc.exited;
	got.cleanup();
	return code;
};

await main();
