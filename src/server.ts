// src/server.ts — the Bun.serve seam. Shadow port 127.0.0.1:4101 ONLY: a
// startup guard refuses 4100 (belt's live gateway address) from any source
// — flag, env, or code — until the owner flips it deliberately. Wires the
// W124 policy file, the upstream pool, the usage ledger, the router and the
// W125 servicemon standard (GET /status, GET /metrics) into one process.
import { CandidateTable } from "./candidates.ts";
import { Cooldowns } from "./cooldown.ts";
import { decideRoute } from "./decide.ts";
import type { RouteHint } from "./hints.ts";
import { createApp, type AppDeps } from "./handlers.ts";
import type { Dialect } from "./upstreams.ts";
import { Ledger } from "./ledger.ts";
import { loadGatewayPolicy, loadPrefs } from "./policy.ts";
import { Router, type RouterMetrics } from "./router.ts";
import { servicemon } from "./servicemon.ts";
import { loadUpstreams } from "./upstreams.ts";

export const SHADOW_PORT = 4101;
export const FORBIDDEN_PORT = 4100;

export interface ServerOpts {
	port?: number;
	hostname?: string;
	dbPath?: string;
	policyPath?: string;
	upstreamsPath?: string;
	prefsPath?: string;
}

/** Port resolution with the 4100 guard; explicit arg wins over env. */
export function resolvePort(explicit?: number): number {
	if (explicit === FORBIDDEN_PORT) {
		throw new Error(
			`port ${FORBIDDEN_PORT} is belt's live address — buckle refuses it until the owner flips it deliberately`,
		);
	}
	const raw = process.env.BUCKLE_PORT ?? "";
	const envPort = raw.length > 0 ? Number(raw) : NaN;
	const port = explicit ?? (Number.isFinite(envPort) ? envPort : SHADOW_PORT);
	if (port === FORBIDDEN_PORT) {
		throw new Error(
			`BUCKLE_PORT=${FORBIDDEN_PORT} refused — buckle's shadow address is ${SHADOW_PORT}`,
		);
	}
	return port;
}

/** Build the app dependencies (policy → pool → ledger → router → app). */
export function buildDeps(
	opts: ServerOpts,
	port: number = SHADOW_PORT,
): AppDeps & { router: Router } {
	const policy = loadGatewayPolicy(opts.policyPath);
	const pool = loadUpstreams(opts.upstreamsPath);
	const prefs = loadPrefs(opts.prefsPath);
	const ledger = new Ledger(
		opts.dbPath ?? process.env.BUCKLE_DB ?? "buckle.db",
	);
	const sm = servicemon({ service: "buckle", port });
	const cooldowns = new Cooldowns(
		policy.allowed_fails ?? 3,
		policy.cooldown_time ?? 30,
	);
	const table = new CandidateTable({ pool, policy, cooldowns });
	table.start();
	const metrics: RouterMetrics = {
		fallback: (tier) =>
			sm
				.counter(
					"buckle_ladder_fallbacks_total",
					"Ladder walks that fell through to a fallback tier.",
				)
				.inc({ tier }),
		cooldown: (dep) =>
			sm
				.counter(
					"buckle_cooldown_ejections_total",
					"Deployments benched into cooldown.",
				)
				.inc({ dep }),
		refused: (tier) =>
			sm
				.counter(
					"buckle_flashx_refusals_total",
					"flashx tiers refused in ladder walks (owner directive).",
				)
				.inc({ tier }),
	};
	const router = new Router(policy, { pool, metrics, cooldowns });
	const decide = (input: {
		group: string;
		dialect: Dialect;
		hint: RouteHint | null;
		hintRaw: string;
	}) =>
		decideRoute({
			...input,
			candidates: table.snapshot(),
			prefs,
		});
	return { router, ledger, sm, pool, decide, table };
}

/** Start buckle on the shadow port. Returns the Bun server for tests. */
export function startServer(
	opts: ServerOpts = {},
): ReturnType<typeof Bun.serve> {
	const port = resolvePort(opts.port);
	const deps = buildDeps(opts, port);
	const app = createApp(deps);
	return Bun.serve({
		hostname: opts.hostname ?? "127.0.0.1",
		port,
		fetch: deps.sm.fetch(app.fetch),
	});
}

/** Entry: bind the shadow port, log the guard. */
export function main(): void {
	const port = resolvePort();
	startServer({ port });
	console.log(
		`buckle: shadow router on http://127.0.0.1:${port} (4100 refused by design)`,
	);
}

if (import.meta.main) main();
