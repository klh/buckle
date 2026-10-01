// src/adapters/index.ts — the adapter registry (W134 §2: dispatch is a
// registry, not LiteLLM's if/elif chain at main.py:5005/:5750-5860 — that
// dispatch tax is exactly what we do not pay). W150: all five families
// resolve; unknown NAMES fail closed unless the catalog knows the provider
// or an explicit adapter_config opts into the openai-compat catch-all.
import type { Dialect } from "../upstreams.ts";
import { ANTHROPIC } from "./anthropic.ts";
import { AZURE_OPENAI } from "./azure-openai.ts";
import { BEDROCK } from "./bedrock.ts";
import { VERTEX } from "./vertex.ts";
import { resolveCatalogFamily } from "./catalog.ts";
import { OPENAI_COMPAT } from "./openai-compat.ts";
import { deriveAdapter, isAdapterFamily, type ChatAdapter } from "./types.ts";

const REGISTRY: Partial<Record<string, ChatAdapter>> = {
	"openai-compat": OPENAI_COMPAT,
	anthropic: ANTHROPIC,
	"azure-openai": AZURE_OPENAI,
	bedrock: BEDROCK,
	vertex: VERTEX,
};

/** Registry lookup. Unknown/unimplemented names throw — never a silent
 *  passthrough (W134 §2 dispatch lesson). */
export function getAdapter(family: string): ChatAdapter {
	const adapter = REGISTRY[family];
	if (!adapter) {
		throw new Error(
			`adapters: family "${family}" has no adapter (tier-2 port pending)`,
		);
	}
	return adapter;
}

/** Deployment → adapter: the explicit per-deployment `adapter:` field wins;
 *  absent, derive from the dialect (W134 §4.2 back-compat). W150: the field
 *  may also name a CATALOG PROVIDER (e.g. `adapter: openrouter` → its row's
 *  family) or, with an explicit adapter_config, an unknown name → the
 *  openai-compat catch-all; otherwise fail closed. */
export function resolveAdapter(dep: {
	adapter?: string;
	dialect: Dialect;
	adapter_config?: Record<string, unknown>;
}): ChatAdapter {
	const name = dep.adapter ?? deriveAdapter(dep.dialect);
	if (isAdapterFamily(name)) return getAdapter(name);
	const hasConfig =
		dep.adapter_config !== undefined &&
		Object.keys(dep.adapter_config).length > 0;
	return getAdapter(resolveCatalogFamily(String(name), hasConfig));
}
