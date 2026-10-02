// src/server.ts — the Bun.serve seam. Shadow port 127.0.0.1:4101 ONLY: a
// startup guard refuses 4100 (belt's live gateway address) from any source
// — flag, env, or code — until the owner flips it deliberately. Wires the
// W124 policy file, the upstream pool, the usage ledger, the router and the
// W125 servicemon standard (GET /status, GET /metrics) into one process.

import { homedir } from "node:os";
import { join } from "node:path";
import { AidsLedger } from "./aids.ts";
import { CandidateTable } from "./candidates.ts";
import { Cooldowns } from "./cooldown.ts";
import { decideRoute } from "./decide.ts";
import { Federation } from "./gov/federation.ts";
import { ManifestSigner } from "./gov/federation-signing.ts";
import { createGovernance, type GovernanceOpts } from "./gov/middleware.ts";
import { type AppDeps, createApp } from "./handlers.ts";
import type { RouteHint } from "./hints.ts";
import { Ledger } from "./ledger.ts";
import { loadGatewayPolicy, loadPrefs } from "./policy.ts";
import { poolWarm, prewarm } from "./pool-warm.ts";
import { Preseeder } from "./preseed.ts";
import { Router, type RouterMetrics } from "./router.ts";
import { servicemon } from "./servicemon.ts";
import type { Dialect } from "./upstreams.ts";
import { loadUpstreams } from "./upstreams.ts";

export const SHADOW_PORT = 4101;
export const FORBIDDEN_PORT = 4100;

/** W199.2 request-body cap: Bun's silent default is 128 MiB — an unbounded
 *  LLM ingress invites memory-hangup abuse. 32 MiB bounds a request while
 *  never touching a legitimate payload (200k-token contexts ≈ 1 MiB, image
 *  base64 well under); Bun answers 413 before the gate or ledger see it. */
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

export interface ServerOpts {
	port?: number;
	hostname?: string;
	dbPath?: string;
	policyPath?: string;
	upstreamsPath?: string;
	prefsPath?: string;
	/** W193: secrets home for the manifest-signing key (hub-only key law).
	 *  Defaults: BUCKLE_SECRETS_HOME env, else ~/.claude/local-llm. */
	secretsHome?: string;
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
	const sm = servicemon({ service: "buckle", port });
	const ledger = new Ledger(
		opts.dbPath ?? process.env.BUCKLE_DB ?? "buckle.db",
		undefined,
		{
			onDrop: (kind, n) =>
				sm
					.counter(
						"buckle_ledger_dropped_total",
						"Ledger rows dropped after bounded flush retries.",
					)
					.inc({ kind }, n),
		},
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
		signer: ManifestSigner.create(
			opts.secretsHome ??
				process.env.BUCKLE_SECRETS_HOME ??
				join(process.env.HOME ?? homedir(), ".claude", "local-llm"),
		),
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
		// W199.2: the explicit body cap — over-cap requests get Bun's 413 and
		// never reach the governance gate, the ledger or the pool.
		maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
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
