// src/repo-policy-routes.ts — W7 repo-policy gate on the :4101 shadow.
// POST /repo-policy/check {repo_root, base_url?, sid?} → the row report.
// Belt calls this at dispatch (the aids/preseed precedent: the hub sees
// the repo in view only as a path the SESSION supplies). Silent when
// satisfied; one actionable missing-question per found gap. policySource
// travels verbatim — pointers (fact:*) resolve only on the local
// owner-report path (bin/repo-policy.ts), never on the wire.
import { statSync } from "node:fs";
import type { RepoPolicyRow, RepoPolicyReport } from "./repo-policy.ts";
import { runRepoPolicies } from "./repo-policy.ts";
import { problem } from "./citizenship.ts";
import type { Servicemon } from "./servicemon.ts";

export interface RepoPolicyDeps {
	rows: RepoPolicyRow[];
	sm: Servicemon;
}

type AnyRec = Record<string, unknown>;

/** One servicemon counter, row × outcome — presence in metrics implies the
 *  row was actually applied (inert rows stay silent, per the law). */
function meter(deps: RepoPolicyDeps, report: RepoPolicyReport): void {
	const outcomes = new Map<string, string>();
	for (const id of report.satisfied) outcomes.set(id, "satisfied");
	for (const g of report.gaps) outcomes.set(g.id, "gap");
	for (const s of report.skips) outcomes.set(s.id, "skipped");
	for (const [row, outcome] of outcomes) {
		deps.sm
			.counter(
				"buckle_repo_policy_checks_total",
				"Repo-policy rows by id and outcome.",
			)
			.inc({ row, outcome });
	}
}

function parseBody(raw: AnyRec): {
	ok: boolean;
	error?: string;
	req?: { repo_root: string; base_url: string | null; sid: string | null };
} {
	const repo_root = typeof raw.repo_root === "string" ? raw.repo_root : "";
	if (!repo_root) return { ok: false, error: "repo_root is required" };
	try {
		if (!statSync(repo_root).isDirectory())
			return { ok: false, error: "repo_root is not a directory" };
	} catch {
		return { ok: false, error: "repo_root is not a directory" };
	}
	return {
		ok: true,
		req: {
			repo_root,
			base_url: typeof raw.base_url === "string" ? raw.base_url : null,
			sid: typeof raw.sid === "string" ? raw.sid : null,
		},
	};
}

/** The repo-policy route table, dispatched from createApp. Unknown
 *  /repo-policy/* paths fall through (404 from the main dispatch); wrong
 *  methods on the known path get 405 + Allow the same way. */
export async function repoPolicyRoutes(
	deps: RepoPolicyDeps,
	req: Request,
	path: string,
): Promise<Response | null> {
	if (req.method !== "POST" || path !== "/repo-policy/check") return null;
	let raw: AnyRec;
	try {
		raw = (await req.json()) as AnyRec;
	} catch {
		return problem({
			status: 400,
			code: "buckle.bad_request",
			why: "invalid JSON body",
			instance: path,
		});
	}
	const parsed = parseBody(raw);
	if (!parsed.ok || !parsed.req)
		return problem({
			status: 400,
			code: "buckle.bad_request",
			why: parsed.error ?? "invalid",
			instance: path,
		});
	const report = await runRepoPolicies(parsed.req.repo_root, {
		rows: deps.rows,
		baseUrl: parsed.req.base_url,
		sid: parsed.req.sid,
	});
	meter(deps, report);
	return Response.json({ ok: true, ...report });
}
