// src/adapters/catalog.ts — the provider catalog (W150): LiteLLM's provider
// breadth as DATA, per the openai_like/providers.json precedent
// (json_loader.py:27/:39/:64). The generated table (catalog-table.ts, one
// row per genuine LiteLLM chat provider) maps each provider to the adapter
// family we route it through; tier = how we serve it (1 native adapter, 2
// family adapter + adapter_config, 3 openai-compat catch-all). Auth shapes
// carry env var NAMES only — never values. flashx is structurally absent.
import type { AdapterFamily } from "./types.ts";
import { CATALOG_TABLE, type CatalogRow } from "./catalog-table.ts";

// hub re-exports: consumers import the catalog from one module
export {
	CATALOG_TABLE,
	type CatalogAuth,
	type CatalogRow,
} from "./catalog-table.ts";

const BY_NAME = new Map(CATALOG_TABLE.map((r) => [r.name, r]));

export interface CatalogSummary {
	count: number;
	byTier: Record<1 | 2 | 3, number>;
	byFamily: Record<AdapterFamily, number>;
}

export function catalogLookup(name: string): CatalogRow | null {
	return BY_NAME.get(name) ?? null;
}

export function catalogSummary(): CatalogSummary {
	const byTier: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
	const byFamily = {
		"openai-compat": 0,
		anthropic: 0,
		"azure-openai": 0,
		bedrock: 0,
		vertex: 0,
	};
	for (const r of CATALOG_TABLE) {
		byTier[r.tier]++;
		byFamily[r.family]++;
	}
	return { count: CATALOG_TABLE.length, byTier, byFamily };
}

/** Provider name → adapter family. Known names resolve to their row's
 *  family; an unknown name resolves to the openai-compat catch-all ONLY
 *  with an explicit adapter_config (the operator's "I know this endpoint"
 *  signal), otherwise it throws — startup fails closed on truly unknown
 *  names (W134 §4.2), never a silent passthrough. */
export function resolveCatalogFamily(
	name: string,
	hasExplicitConfig: boolean,
): AdapterFamily {
	const hit = BY_NAME.get(name);
	if (hit) return hit.family;
	if (hasExplicitConfig) return "openai-compat";
	throw new Error(
		`adapters: unknown adapter "${name}" — not a family, not a catalog ` +
			`provider; supply adapter_config for the openai-compat catch-all`,
	);
}
