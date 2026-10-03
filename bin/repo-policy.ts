// bin/repo-policy.ts — W7 repo-policy gate CLI: run the rows against a
// repo in view from a terminal. Silent when satisfied (one summary line);
// each found gap prints exactly one actionable missing-question. With
// --resolve-facts, fact:<name> policySources expand via the LOCAL coord —
// owner-report path only, never the wire, never a model context.
//
//	bun bin/repo-policy.ts <repo-root> [--policy <path>] [--base-url <url>]
//	                     [--resolve-facts] [--json]
import {
	loadRepoPolicies,
	resolvePolicySource,
	runRepoPolicies,
} from "../src/repo-policy.ts";
import { isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";

const arg = (name: string): string | null => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const out = (s = ""): void => process.stdout.write(`${s}\n`);

const main = async (): Promise<number> => {
	if (has("help") || process.argv[2] === undefined) {
		out(
			"usage: bun bin/repo-policy.ts <repo-root> [--policy <path>] [--base-url <url>] [--resolve-facts] [--json]",
		);
		return process.argv[2] === undefined ? 2 : 0;
	}
	const rawRoot = process.argv[2] as string;
	const root = isAbsolute(rawRoot) ? rawRoot : resolve(rawRoot);
	try {
		if (!statSync(root).isDirectory()) {
			out(`repo-policy: ${root} is not a directory`);
			return 2;
		}
	} catch {
		out(`repo-policy: ${root} is not a directory`);
		return 2;
	}
	const { rows, source } = loadRepoPolicies(arg("policy") ?? undefined);
	if (rows.length === 0) {
		out(`repo-policy: no rows loaded (${source}) — inert`);
		return 0;
	}
	const report = await runRepoPolicies(root, {
		rows,
		baseUrl: arg("base-url"),
	});
	if (has("json")) {
		out(JSON.stringify(report, null, 2));
		return report.gaps.length === 0 ? 0 : 1;
	}
	for (const gap of report.gaps) {
		out(`! ${gap.id} (${gap.repoClass}): ${gap.missingQuestion}`);
		out(`    policy: ${gap.policySource}`);
		if (has("resolve-facts")) {
			const text = await resolvePolicySource(gap.policySource);
			if (text !== gap.policySource) {
				for (const line of text.split("\n")) out(`    > ${line}`);
			}
		}
	}
	if (report.skips.length > 0) {
		for (const s of report.skips) out(`  skip ${s.id}: ${s.reason}`);
	}
	out(
		report.gaps.length === 0
			? `ok ${root}: ${report.applied} row(s) applied, all satisfied`
			: `${report.gaps.length} gap(s) in ${root} (${report.applied} row(s) applied)`,
	);
	return report.gaps.length === 0 ? 0 : 1;
};

const code = await main();
process.exit(code);
