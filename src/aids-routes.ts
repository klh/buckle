// src/aids-routes.ts — W142 aid endpoints on the :4101 shadow. Buckle is
// the enforcement point: it validates, verifies, caps, logs, and skips
// honestly (aids are garnish — an outage must never block a dispatch).
// POST /aids/preseed  {domain, focus?, repo_root, sid?, work_item?}
// GET  /aids/status   — meter totals for dashboards
// GET  /aids/rollup   — hourly govdb-shaped rollup rows (harvest seam)
// Wire path (LLM requests): the x-belt-aids header declares aids per
// request; cache-align runs ONLY when declared (pass-through doctrine).
import { parseAids, tokensEstimate, type AidsLedger } from "./aids.ts";
import { alignBody } from "./align.ts";
import type { Preseeder } from "./preseed.ts";
import type { AidsPolicy } from "./policy.ts";
import type { Servicemon } from "./servicemon.ts";
import type { Dialect } from "./upstreams.ts";

export interface AidsDeps {
	aids: AidsLedger;
	preseeder: Preseeder;
	aidsPolicy: AidsPolicy;
	sm: Servicemon;
}

type AnyRec = Record<string, unknown>;

/** Meter one decision: ledger row + servicemon counters (an aid that
 *  cannot log does not fire — the counters are the live face of the law). */
function meter(
	deps: AidsDeps,
	ev: {
		aid: string;
		decision: "injected" | "skipped" | "rebuilt";
		skip_reason?: string | null;
		domain?: string;
		repo_root?: string | null;
		sid?: string | null;
		work_item?: string | null;
		packet_id?: string | null;
		tokens_injected?: number;
	},
): void {
	deps.aids.record({ ...ev, ts: Date.now(), basis: undefined });
	deps.sm
		.counter("buckle_aids_decisions_total", "Aid decisions by aid + outcome.")
		.inc({
			aid: ev.aid,
			decision: ev.decision,
			...(ev.skip_reason ? { reason: ev.skip_reason } : {}),
		});
	deps.sm
		.counter(
			"buckle_aids_tokens_injected_total",
			"Estimated tokens injected by aids.",
		)
		.inc({ aid: ev.aid }, ev.tokens_injected ?? 0);
}

function parsePreseedBody(raw: AnyRec): {
	ok: boolean;
	error?: string;
	req?: {
		domain: string;
		focus: string[];
		repo_root: string;
		sid: string | null;
		work_item: string | null;
	};
} {
	const domain = typeof raw.domain === "string" ? raw.domain.trim() : "";
	const repo_root = typeof raw.repo_root === "string" ? raw.repo_root : "";
	if (!domain || !repo_root)
		return { ok: false, error: "domain and repo_root are required" };
	const focus = Array.isArray(raw.focus)
		? raw.focus.filter((f): f is string => typeof f === "string")
		: [];
	return {
		ok: true,
		req: {
			domain,
			focus,
			repo_root,
			sid: typeof raw.sid === "string" ? raw.sid : null,
			work_item: typeof raw.work_item === "string" ? raw.work_item : null,
		},
	};
}

/** POST /aids/preseed — belt calls this at dispatch. Policy is buckle's;
 *  the aids stanza lives in the brief (belt is the policy point). */
export async function aidsPreseed(
	deps: AidsDeps,
	req: Request,
): Promise<Response> {
	let raw: AnyRec;
	try {
		raw = (await req.json()) as AnyRec;
	} catch {
		return Response.json(
			{ ok: false, error: "invalid JSON body" },
			{ status: 400 },
		);
	}
	const parsed = parsePreseedBody(raw);
	if (!parsed.ok || !parsed.req)
		return Response.json(
			{ ok: false, error: parsed.error ?? "invalid" },
			{ status: 400 },
		);
	const out = await deps.preseeder.preseed(parsed.req);
	meter(deps, {
		aid: "preseed",
		decision: out.decision,
		skip_reason: out.skip_reason ?? null,
		domain: parsed.req.domain,
		repo_root: parsed.req.repo_root,
		sid: parsed.req.sid,
		work_item: parsed.req.work_item,
		packet_id: out.packet_id ?? null,
		tokens_injected: out.bytes ? tokensEstimate(out.bytes) : 0,
	});
	return Response.json({ ok: true, ...out });
}

/** GET /aids/status — meter totals (the honest immediate metrics: tokens
 *  injected + decision counts; est saved is A/B-derived at dashboard time). */
export function aidsStatus(deps: AidsDeps): Response {
	const s = deps.aids.status();
	deps.aids.rollup(24);
	return Response.json({
		ok: true,
		events: s.n ?? 0,
		injected: s.injected ?? 0,
		skipped: s.skipped ?? 0,
		tok_injected: s.tok_injected ?? 0,
		last_ts: s.last_ts ?? null,
		rollup_rows: deps.aids.rollupRows(24).length,
	});
}

/** GET /aids/rollup?hours=N — govdb-shaped hourly rows. The pull seam for
 *  the suspenders-side harvest (aid-harvest.ts → governor.db aid_rollup). */
export function aidsRollup(deps: AidsDeps, hours: number): Response {
	deps.aids.rollup(24);
	const h = Number.isFinite(hours) ? Math.min(168, Math.max(1, hours)) : 24;
	return Response.json({ ok: true, rows: deps.aids.rollupRows(h) });
}

/** Wire-path aids: called on every proxied request. No x-belt-aids header →
 *  zero touch (pass-through doctrine). Returns the (possibly aligned) body. */
export function applyWireAids(
	deps: AidsDeps,
	header: string | null,
	body: AnyRec,
	dialect: Dialect,
): { body: AnyRec; aligned: boolean } {
	const stanza = parseAids(header);
	if (stanza.unknown.length > 0) {
		for (const u of stanza.unknown)
			meter(deps, {
				aid: u,
				decision: "skipped",
				skip_reason: "policy",
			});
	}
	if (stanza.off) return { body, aligned: false };
	if (stanza.compress) {
		// wired, DEFAULT-OFF (W137 economics): policy forbids → skip, metered
		const on = deps.aidsPolicy.compress?.default === "on";
		meter(deps, {
			aid: "compress",
			decision: "skipped",
			skip_reason: on ? "invalid" : "policy",
		});
	}
	const ca = stanza["cache-align"];
	if (ca && dialect === "anthropic") {
		const aligned = alignBody(body, dialect);
		meter(deps, {
			aid: "cache-align",
			decision: aligned ? "injected" : "skipped",
			skip_reason: aligned ? null : "unsupported",
		});
		if (aligned?.body) return { body: aligned.body, aligned: true };
	}
	return { body, aligned: false };
}

/** The aids route table, dispatched from createApp. Unknown /aids/* paths
 *  fall through (404 from the main dispatch). */
export async function aidsRoutes(
	deps: AidsDeps,
	req: Request,
	path: string,
): Promise<Response | null> {
	const url = new URL(req.url);
	if (req.method === "POST" && path === "/aids/preseed")
		return aidsPreseed(deps, req);
	if (req.method === "GET" && path === "/aids/status") return aidsStatus(deps);
	if (req.method === "GET" && path === "/aids/rollup")
		return aidsRollup(deps, Number(url.searchParams.get("hours") ?? "24"));
	if (req.method === "GET" && path === "/aids/events")
		return aidsEvents(deps, Number(url.searchParams.get("since") ?? "0"));
	return null;
}

/** GET /aids/events?since=MS — raw event pull for the suspenders-side
 *  harvest (governor.db aid_events join seam: sid → sessions → actor). */
function aidsEvents(deps: AidsDeps, since: number): Response {
	const sinceMs = Number.isFinite(since) && since > 0 ? since : 0;
	return Response.json({
		ok: true,
		events: deps.aids.eventsSince(sinceMs),
	});
}
