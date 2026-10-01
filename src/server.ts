// src/server.ts — the Bun.serve seam. Shadow port 127.0.0.1:4101 ONLY: a
// startup guard refuses 4100 (belt's live gateway address) from any source
// — flag, env, or code — until the owner flips it deliberately. Wires the
// W124 policy file, the upstream pool, the usage ledger, the router and the
// W125 servicemon standard (GET /status, GET /metrics) into one process.
import { CandidateTable } from "./candidates.ts";
import { AidsLedger } from "./aids.ts";
import { Preseeder } from "./preseed.ts";
import { Cooldowns } from "./cooldown.ts";
import { decideRoute } from "./decide.ts";
import type { RouteHint } from "./hints.ts";
import { createApp, type AppDeps } from "./handlers.ts";
import type { Dialect } from "./upstreams.ts";
import { Ledger } from "./ledger.ts";
import { poolWarm, prewarm } from "./pool-warm.ts";
import { createGovernance, type GovernanceOpts } from "./gov/middleware.ts";
import { Federation } from "./gov/federation.ts";
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
	// W141 governance: root break-glass key + optional JWT validator config.
	auth?: Pick<GovernanceOpts, "rootKey" | "jwt">;
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
	// W142 knowledge aids: metering ledger + preseed builder on the same db
	// file (W133 wiring); policy slice from the shared routing-policy.yaml.
	const aids = new AidsLedger(
		opts.dbPath ?? process.env.BUCKLE_DB ?? "buckle.db",
	);
	const aidsPolicy = policy.aids ?? {};
	const preseeder = new Preseeder({
		policy: aidsPolicy,
		knowledgeUrl:
			aidsPolicy.preseed?.knowledge_url ?? process.env.BUCKLE_KNOWLEDGE_API,
	});
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
	// W143 speed pass: the warm-rate gate's servicemon counter + the boot
	// pre-warm — one GET /v1/models per unique deployment origin (the
	// gateway-config.ts precedent), so TLS/auth are established before the
	// first real request. Failed origins stay cold and honestly count a
	// pool_refill on their first dispatch.
	poolWarm.setSink((origin) =>
		sm
			.counter(
				"buckle_pool_refills_total",
				"Cold-connect transitions on the request path (pool_refill).",
			)
			.inc({ origin }),
	);
	void prewarm(pool);
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
	const dbPath = opts.dbPath ?? process.env.BUCKLE_DB ?? "buckle.db";
	const federation = new Federation({
		dbPath,
		policy,
		pool,
		policyPath: opts.policyPath,
	});
	return {
		router,
		ledger,
		aids,
		preseeder,
		aidsPolicy,
		sm,
		pool,
		decide,
		table,
		federation,
	};
}

/** Start buckle on the shadow port. Returns the Bun server for tests, with
 *  `.gov` attached (W154: tests and W160 seed/read the CR queue through it). */
export function startServer(
	opts: ServerOpts = {},
): ReturnType<typeof Bun.serve> & { gov: ReturnType<typeof createGovernance> } {
	const port = resolvePort(opts.port);
	const deps = buildDeps(opts, port);
	const app = createApp(deps);
	// W141 governance gate: enforced unless BUCKLE_AUTH=off (empty string
	// counts as unset — the W147 empty-env lesson).
	const authEnv = process.env.BUCKLE_AUTH ?? "";
	const authOn = authEnv.length > 0 ? authEnv !== "off" : true;
	const gov = createGovernance(
		{ ledger: deps.ledger, sm: deps.sm },
		{
			dbPath: opts.dbPath ?? process.env.BUCKLE_DB ?? "buckle.db",
			rootKey: opts.auth?.rootKey,
			jwt: opts.auth?.jwt,
			federation: deps.federation,
		},
	);
	gov.budgets.startFlushTimer();
	const gated = authOn ? gov.gate(app.fetch) : app.fetch;
	const inner = deps.sm.fetch(gated);
	const server = Bun.serve({
		hostname: opts.hostname ?? "127.0.0.1",
		port,
		fetch: inner,
	});
	return Object.assign(server, { gov }) as ReturnType<typeof Bun.serve> & {
		gov: ReturnType<typeof createGovernance>;
	};
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
