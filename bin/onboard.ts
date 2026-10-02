// bin/onboard.ts — W227-A3 zero-dep interactive onboarding. Detects the
// coding agents known to src/agents.ts, lets the owner pick via a numbered
// checkbox list, summarizes, and only then writes: env exports are printed
// (and offered — asked, never silent — for ~/.zshrc), config edits land with
// a sibling .bak and refuse to touch a non-empty file without --force.
// --dry-run prints the plan for all recipes and writes nothing; --verify
// runs each recipe's probe against the LOCAL gateway only, never a paid
// endpoint (a non-local --base-url is refused in verify mode).
//
//	bun bin/onboard.ts [--dry-run] [--verify] [--all] [--base-url URL] [--force]

import {
	DEFAULT_BASE_URL,
	DEFAULT_MODEL,
	agentRecipes,
	detectAgents,
	expandPath,
	type AgentRecipe,
	type DetectedAgent,
} from "../src/agents.ts";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";

// ── args + consts ──
const arg = (name: string): string | null => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const DRY = has("dry-run");
const VERIFY = has("verify");
const ALL = has("all");
const FORCE = has("force");
const BASE_URL = (arg("base-url") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
const RC_PATH = join(homedir(), ".zshrc");
const RC_MARKER_PREFIX = "# >>> buckle reroute";
const PROBE_TIMEOUT_MS = 10_000;
const CLI_OUT_CAP = 64 * 1024; // bounded capture for cli probes (streams law)
const MAX_CONFIG_BYTES = 1024 * 1024; // refuse configs > 1 MiB (streams law)

const out = (s = ""): void => {
	process.stdout.write(`${s}\n`);
};
const err = (s = ""): void => {
	process.stderr.write(`${s}\n`);
};

// ── probes (local-only; bounded reads everywhere) ──
interface ProbeResult {
	ok: boolean;
	detail: string;
}

/** Read a stream with a hard cap: cap reached → cancel, never buffer on. */
const readBounded = async (
	stream: ReadableStream<Uint8Array>,
	cap: number,
): Promise<string> => {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done || !value) break;
		if (total + value.byteLength > cap) {
			await reader.cancel("probe output cap reached");
			break;
		}
		chunks.push(value);
		total += value.byteLength;
	}
	const all = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		all.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(all);
};

const probeHttp = async (
	probe: { url: string },
	wire: AgentRecipe["wire"],
): Promise<ProbeResult> => {
	// anthropic dialect: a 1-token POST /v1/messages ping; everything else:
	// a GET against the probe url (…/models). Any answer < 500 means the
	// gateway is alive (4xx = auth/config problem, reported, not fatal).
	const anthropic = wire === "anthropic";
	const headers: Record<string, string> = anthropic
		? {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				...(process.env.ANTHROPIC_API_KEY
					? { "x-api-key": process.env.ANTHROPIC_API_KEY }
					: {}),
			}
		: {};
	try {
		const res = await fetch(probe.url, {
			method: anthropic ? "POST" : "GET",
			headers,
			body: anthropic
				? JSON.stringify({
						model: DEFAULT_MODEL,
						max_tokens: 1,
						messages: [{ role: "user", content: "ping" }],
					})
				: undefined,
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		const move = anthropic ? "POST" : "GET";
		if (res.status < 400) {
			return { ok: true, detail: `${res.status} from ${move} ${probe.url}` };
		}
		if (res.status === 401 || res.status === 403) {
			return {
				ok: true,
				detail: `${res.status} from ${move} ${probe.url} — gateway alive, auth required`,
			};
		}
		if (res.status === 404 || res.status === 410) {
			return {
				ok: false,
				detail: `${res.status} from ${move} ${probe.url} — no such route`,
			};
		}
		return { ok: false, detail: `${res.status} from ${move} ${probe.url}` };
	} catch (error) {
		return {
			ok: false,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
};

const probeCli = async (probe: {
	argv: string[];
	expect: string;
}): Promise<ProbeResult> => {
	try {
		const proc = Bun.spawn(probe.argv, {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		const killer = setTimeout(() => {
			try {
				proc.kill();
			} catch {
				// already exited — nothing to kill
			}
		}, PROBE_TIMEOUT_MS);
		const text = await readBounded(proc.stdout, CLI_OUT_CAP);
		const code = await proc.exited;
		clearTimeout(killer);
		const first = text.trim().split("\n")[0]?.slice(0, 60) ?? "";
		if (code === 0 && text.includes(probe.expect)) {
			return { ok: true, detail: `${probe.argv[0]} ok — ${first}` };
		}
		return {
			ok: false,
			detail: `exit ${code} — '${probe.expect}' not in stdout (${first})`,
		};
	} catch (error) {
		return {
			ok: false,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
};

const runProbe = async (recipe: AgentRecipe): Promise<ProbeResult> => {
	const probe = recipe.probe;
	if (probe.kind === "cli") return probeCli(probe);
	return probeHttp(probe, recipe.wire);
};

// ── interactive picker (raw-mode keypresses via node:readline) ──
interface PickResult {
	picked: boolean[];
	everywhere: boolean;
}

interface KeypressKey {
	name?: string;
	ctrl?: boolean;
}

const pickAgents = (rows: DetectedAgent[]): Promise<PickResult | null> => {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return Promise.resolve(null);
	}
	return new Promise((resolve) => {
		const stdin = process.stdin;
		const picked: boolean[] = rows.map((row) => row.detected);
		let everywhere = false;
		let drawn = 0;

		const lines = (): string[] => {
			const outLines: string[] = [];
			rows.forEach((row, i) => {
				const box = picked[i] === true ? "[x]" : "[ ]";
				const status = row.detected
					? `detected (${row.signals.join(", ")})`
					: "not detected";
				outLines.push(`  ${box} ${i + 1}. ${row.recipe.label} — ${status}`);
			});
			outLines.push("");
			outLines.push(
				`  toggle 1-${rows.length} · a all · e all + everywhere (env → ~/.zshrc)` +
					`${everywhere ? "  [everywhere ON]" : ""} · Enter confirm · Ctrl-C abort`,
			);
			return outLines;
		};

		const render = (first: boolean): void => {
			const ls = lines();
			if (!first) process.stdout.write(`\x1b[${drawn}A`);
			for (const line of ls) process.stdout.write(`\r\x1b[K${line}\n`);
			drawn = ls.length;
		};

		const cleanup = (): void => {
			stdin.removeListener("keypress", onKey);
			if (stdin.isTTY) stdin.setRawMode(false);
			stdin.pause();
		};

		const onKey = (
			str: string | undefined,
			key: KeypressKey | undefined,
		): void => {
			if (str === "\u0003" || (key?.ctrl === true && key?.name === "c")) {
				cleanup();
				err("onboard: aborted — nothing written");
				process.exit(130);
			}
			if (key?.name === "return" || key?.name === "enter") {
				cleanup();
				resolve({ picked, everywhere });
				return;
			}
			if (str === "a") {
				picked.fill(true);
			} else if (str === "e") {
				picked.fill(true);
				everywhere = true;
			} else if (str !== undefined && /^[1-9]$/.test(str)) {
				const i = Number(str) - 1;
				if (i < picked.length) picked[i] = !picked[i];
			}
			render(false);
		};

		readline.emitKeypressEvents(stdin);
		stdin.setRawMode(true);
		stdin.resume();
		stdin.on("keypress", onKey);
		out(
			`\nbuckle onboarding — reroute local coding agents through ${BASE_URL}`,
		);
		render(true);
	});
};

// ── line prompts (typed confirmations; works piped and on a tty) ──
const ask = (question: string): Promise<string> =>
	new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.on("SIGINT", () => {
			rl.close();
			err("\nonboard: aborted — nothing written");
			process.exit(130);
		});
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer);
		});
	});

// ── plan printing (dry-run + summary) ──
const exportLines = (env: Record<string, string>): string[] =>
	Object.entries(env).map(([k, v]) => `export ${k}="${v}"`);

const printPlan = (recipes: AgentRecipe[]): void => {
	for (const recipe of recipes) {
		out(`── ${recipe.label} ──`);
		if (recipe.reroute.env) {
			for (const line of exportLines(recipe.reroute.env)) out(line);
			out("(printed only at apply time; ~/.zshrc only via an explicit ask)");
		}
		if (recipe.reroute.configEdit) {
			const edit = recipe.reroute.configEdit;
			out(`edit ${expandPath(edit.file)}:`);
			for (const line of edit.value.trimEnd().split("\n")) {
				out(`  ${line}`);
			}
			out(
				`(sibling .bak before overwriting a non-empty file; without --force ` +
					`a non-empty ${edit.file} is refused)`,
			);
		}
		if (recipe.notes) out(`notes: ${recipe.notes}`);
	}
};

// ── apply: config edits ──
interface EditVerdict {
	action?: string;
	refusal?: string;
}

const applyConfigEdit = (
	id: string,
	edit: NonNullable<AgentRecipe["reroute"]["configEdit"]>,
): EditVerdict => {
	const target = expandPath(edit.file);
	if (!existsSync(target)) {
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, edit.value);
		return { action: `${id}: created ${edit.file}` };
	}
	const size = statSync(target).size;
	if (size > MAX_CONFIG_BYTES) {
		return {
			refusal: `${edit.file}: ${size} bytes — over the 1 MiB config cap, refusing (streams law)`,
		};
	}
	if (size === 0) {
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, edit.value);
		return {
			action: `${id}: wrote ${edit.anchor} block into empty ${edit.file}`,
		};
	}
	if (!FORCE) {
		return {
			refusal: `${edit.file}: non-empty existing config — re-run with --force to append the ${edit.anchor} block (a sibling .bak is made first)`,
		};
	}
	const existing = readFileSync(target, "utf8");
	if (existing.includes(edit.anchor)) {
		return {
			action: `${id}: ${edit.file} already contains ${edit.anchor} — left as-is`,
		};
	}
	copyFileSync(target, `${target}.bak`);
	writeFileSync(target, `${existing.replace(/\n+$/, "\n")}${edit.value}`);
	return {
		action: `${id}: appended ${edit.anchor} block to ${edit.file} (backup: ${edit.file}.bak)`,
	};
};

// ── apply: ~/.zshrc (marker-wrapped, idempotent, always asked first) ──
const appendRc = (blocks: Array<{ id: string; lines: string[] }>): string => {
	const block = blocks
		.map(({ id, lines }) =>
			[
				`${RC_MARKER_PREFIX} (${id})`,
				...lines,
				`# <<< buckle reroute (${id}) <<<`,
			].join("\n"),
		)
		.join("\n");
	const count = blocks.reduce((n, b) => n + b.lines.length, 0);
	if (existsSync(RC_PATH)) {
		const size = statSync(RC_PATH).size;
		if (size > MAX_CONFIG_BYTES) {
			return `${RC_PATH}: over the 1 MiB cap — refusing (streams law)`;
		}
		const rc = readFileSync(RC_PATH, "utf8");
		if (rc.includes(RC_MARKER_PREFIX)) {
			return `${RC_PATH}: a buckle block is already present — skipped (edit it or remove the marker lines first)`;
		}
		const lead = rc.length === 0 || rc.endsWith("\n") ? "" : "\n";
		appendFileSync(RC_PATH, `${lead}${block}\n`);
		return `appended ${count} export line(s) to ${RC_PATH} (marker-wrapped)`;
	}
	appendFileSync(RC_PATH, `${block}\n`);
	return `created ${RC_PATH} with ${count} export line(s) (marker-wrapped)`;
};

// ── usage ──
const usage = (): void => {
	out(`buckle onboarding — wire local coding agents to the buckle gateway

  bun bin/onboard.ts [--dry-run] [--verify] [--all] [--base-url URL] [--force]

  --dry-run       print the plan for ALL recipes, write nothing
  --verify        run each recipe's local probe (never a paid endpoint)
  --all           skip the picker (select every recipe)
  --base-url URL  gateway base (default ${DEFAULT_BASE_URL})
  --force         allow appending into a non-empty config (.bak made first)

  picker keys: number toggle · a all · e all + everywhere (env → ~/.zshrc)
               Enter confirm · Ctrl-C abort`);
};

// ── main ──
const isLocal = (url: string): boolean => {
	try {
		return ["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname);
	} catch {
		return false;
	}
};

const main = async (): Promise<number> => {
	if (has("help")) {
		usage();
		return 0;
	}
	if (VERIFY && !isLocal(BASE_URL)) {
		err(
			`onboard: --verify refuses non-local base ${BASE_URL} — probes never leave this machine`,
		);
		return 1;
	}

	const recipes = agentRecipes(BASE_URL);

	if (VERIFY) {
		const rows = detectAgents(recipes);
		out(`buckle verify — probing the local gateway at ${BASE_URL}\n`);
		let failures = 0;
		for (const row of rows) {
			const verdict = await runProbe(row.recipe);
			if (!verdict.ok) failures++;
			out(
				`  ${row.recipe.id.padEnd(8)} ${row.recipe.label.padEnd(20)} ` +
					`${row.detected ? "detected" : "absent  "}  ` +
					`${verdict.ok ? "ok  " : "FAIL"}  ${verdict.detail}`,
			);
		}
		out(
			`\n${failures === 0 ? "all probes green" : `${failures} probe(s) red`}`,
		);
		return failures === 0 ? 0 : 1;
	}

	if (DRY) {
		out(
			`buckle onboarding — dry run, NOTHING will be written (base ${BASE_URL})\n`,
		);
		printPlan(recipes);
		out("\n(dry run complete — nothing written)");
		return 0;
	}

	// ── selection ──
	const rows = detectAgents(recipes);
	let picked: AgentRecipe[];
	let everywhere = false;
	if (ALL) {
		picked = recipes;
	} else {
		const selection = await pickAgents(rows);
		if (!selection) {
			err(
				"onboard: no TTY for the picker — re-run with --dry-run, --verify or --all",
			);
			return 1;
		}
		picked = rows
			.filter((_, i) => selection.picked[i] === true)
			.map((row) => row.recipe);
		everywhere = selection.everywhere;
	}
	if (picked.length === 0) {
		out("nothing selected — nothing written");
		return 0;
	}

	// ── summary + typed confirm gate ──
	out("\nplan ──");
	for (const recipe of picked) {
		const moves: string[] = [];
		if (recipe.reroute.env) {
			moves.push(
				`${Object.keys(recipe.reroute.env).length} export line(s) printed`,
			);
		}
		if (recipe.reroute.configEdit) {
			moves.push(`edit ${recipe.reroute.configEdit.file}`);
		}
		out(`  ${recipe.label.padEnd(20)} ${moves.join(" + ")}`);
	}
	if (everywhere) {
		out(`  everywhere:          env block offered for ${RC_PATH}`);
	}
	out(`  base url:            ${BASE_URL}`);

	const gate = (await ask("\ntype 'yes' to apply (anything else aborts): "))
		.trim()
		.toLowerCase();
	if (gate !== "yes") {
		out("aborted — nothing written");
		return 1;
	}

	// ── apply ──
	const actions: string[] = [];
	const refusals: string[] = [];
	const rcBlocks: Array<{ id: string; lines: string[] }> = [];

	for (const recipe of picked) {
		const env = recipe.reroute.env;
		if (env) {
			const lines = exportLines(env);
			out(`\n# buckle reroute — ${recipe.label}`);
			for (const line of lines) out(line);
			actions.push(`${recipe.label}: ${lines.length} export line(s) printed`);
			rcBlocks.push({ id: recipe.id, lines });
		}
		const edit = recipe.reroute.configEdit;
		if (edit) {
			const verdict = applyConfigEdit(recipe.id, edit);
			if (verdict.refusal) refusals.push(verdict.refusal);
			if (verdict.action) actions.push(verdict.action);
		}
	}

	if (everywhere && rcBlocks.length > 0) {
		const total = rcBlocks.reduce((n, b) => n + b.lines.length, 0);
		const names = rows
			.filter((row) => rcBlocks.some((b) => b.id === row.recipe.id))
			.map((row) => row.recipe.label)
			.join(", ");
		const okRc = (
			await ask(
				`\nappend ${total} export line(s) for ${names} to ${RC_PATH}? [y/N] `,
			)
		)
			.trim()
			.toLowerCase();
		if (okRc.startsWith("y")) {
			actions.push(appendRc(rcBlocks));
		} else {
			actions.push(`${RC_PATH}: not touched (declined)`);
		}
	}

	// ── report ──
	out("\nsummary ──");
	for (const action of actions) out(`  + ${action}`);
	for (const refusal of refusals) out(`  ! ${refusal}`);
	return refusals.length > 0 ? 1 : 0;
};

const code = await main();
process.exit(code);
