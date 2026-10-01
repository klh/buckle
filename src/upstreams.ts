// src/upstreams.ts — the upstream pool: group name == wire id (the model
// string clients send), deployments carry the dialect. Committed default is
// loopback-only; cloud tiers ship dormant (empty groups) and are activated by
// a BUCKLE_UPSTREAMS override file merged over the default by group name.
// Keys NEVER live in committed files: api_key_env names an env var read at
// request time.
import { YAML } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { resolveAdapter } from "./adapters/index.ts";
import { deriveAdapter } from "./adapters/types.ts";

export type Dialect = "openai" | "anthropic";

export interface Deployment {
	url: string;
	dialect: Dialect;
	// upstream's real model id when the group alias differs — the request
	// body's model field is patched toward this deployment; absent = forward
	// the client's model string verbatim.
	model?: string;
	// env var name holding the bearer token (never the token itself)
	api_key_env?: string;
	// per-DEPLOYMENT wire family (W134 §4.2): absent = derived from the
	// dialect; a group may mix families. W150: may also name a catalog
	// provider (src/adapters/catalog-table.ts) or, with an explicit
	// adapter_config, an unknown name resolves to the openai-compat
	// catch-all (fail-closed otherwise).
	adapter?: string;
	// family parameters (region, project, api-version) — never secrets
	adapter_config?: Record<string, unknown>;
	// W154 visibility law: `spoke-private` excludes the group from
	// /federation/entitlements (defensive marker; spoke-local pools are
	// structurally absent from the hub pool anyway).
	visibility?: string;
	group: string;
}

interface UpstreamsDoc {
	version?: number;
	groups: Record<string, DeploymentSpec[]>;
}

interface DeploymentSpec {
	url: string;
	dialect: Dialect;
	model?: string;
	api_key_env?: string;
	adapter?: string;
	adapter_config?: Record<string, unknown>;
	visibility?: string;
}

export interface UpstreamPool {
	groups(): string[];
	deployments(group: string): Deployment[];
}

const DEFAULT_UPSTREAMS = new URL("../upstreams.yaml", import.meta.url)
	.pathname;

function parseUpstreams(text: string, source: string): UpstreamsDoc {
	const doc = YAML.parse(text) as UpstreamsDoc | null;
	if (!doc || typeof doc !== "object" || !doc.groups)
		throw new Error(`upstreams: ${source} has no groups mapping`);
	return doc;
}

/** Merge override groups over base groups (same-named group is replaced). */
export function mergeUpstreams(
	base: UpstreamsDoc,
	over: UpstreamsDoc,
): UpstreamsDoc {
	return {
		version: 1,
		groups: { ...base.groups, ...over.groups },
	};
}

function poolFrom(doc: UpstreamsDoc): UpstreamPool {
	const groups = new Map<string, Deployment[]>();
	for (const [group, specs] of Object.entries(doc.groups)) {
		groups.set(
			group,
			(specs ?? []).map((s) => {
				const dep = { ...s, group };
				// startup fatal (W134 §4.2): unknown adapter names — and known
				// tier-2 families with no adapter yet — fail closed here,
				// naming the offending group, never a silent passthrough.
				if (dep.adapter === undefined) dep.adapter = deriveAdapter(dep.dialect);
				try {
					resolveAdapter(dep);
				} catch (e) {
					throw new Error(
						`upstreams: group "${group}": ${e instanceof Error ? e.message : String(e)}`,
					);
				}
				return dep;
			}),
		);
	}
	return {
		groups: (): string[] => [...groups.keys()],
		deployments: (group: string): Deployment[] => groups.get(group) ?? [],
	};
}

/** Resolution: explicit path → BUCKLE_UPSTREAMS → committed default (the
 *  override file merges over the default; groups it declares win). */
export function loadUpstreams(explicitPath?: string): UpstreamPool {
	const basePath = explicitPath ?? DEFAULT_UPSTREAMS;
	let doc = parseUpstreams(readFileSync(basePath, "utf8"), basePath);
	const overPath = process.env.BUCKLE_UPSTREAMS;
	if (overPath && existsSync(overPath)) {
		doc = mergeUpstreams(
			doc,
			parseUpstreams(readFileSync(overPath, "utf8"), overPath),
		);
	}
	return poolFrom(doc);
}
