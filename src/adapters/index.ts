// src/adapters/index.ts — the adapter registry (W134 §2: dispatch is a
// registry, not LiteLLM's if/elif chain at main.py:5005/:5750-5860 — that
// dispatch tax is exactly what we do not pay). Unknown names fail closed:
// the pool validator rejects them at startup, naming the offending group.
import type { Dialect } from "../upstreams.ts";
import { ANTHROPIC } from "./anthropic.ts";
import { OPENAI_COMPAT } from "./openai-compat.ts";
import {
	ADAPTER_FAMILIES,
	deriveAdapter,
	isAdapterFamily,
	type AdapterFamily,
	type ChatAdapter,
} from "./types.ts";

const REGISTRY: Partial<Record<AdapterFamily, ChatAdapter>> = {
	"openai-compat": OPENAI_COMPAT,
	anthropic: ANTHROPIC,
	// azure-openai / bedrock / vertex: tier-2 ports (W134 §3) — a config
	// naming them fails closed at startup (see getAdapter) until a port lands
};

/** Registry lookup. Unknown/unimplemented families throw — never a silent
 *  passthrough (W134 §2 dispatch lesson). */
export function getAdapter(family: AdapterFamily): ChatAdapter {
	const adapter = REGISTRY[family];
	if (!adapter) {
		throw new Error(
			`adapters: family "${family}" has no adapter (tier-2 port pending)`,
		);
	}
	return adapter;
}

/** Deployment → adapter: the explicit per-deployment `adapter:` field wins;
 *  absent, derive from the dialect (W134 §4.2 back-compat — every
 *  pre-adapter deployment resolves through here). */
export function resolveAdapter(dep: {
	adapter?: AdapterFamily;
	dialect: Dialect;
}): ChatAdapter {
	const family = dep.adapter ?? deriveAdapter(dep.dialect);
	if (!isAdapterFamily(family)) {
		throw new Error(
			`adapters: unknown adapter "${String(family)}" (known: ${ADAPTER_LIST})`,
		);
	}
	return getAdapter(family);
}

const ADAPTER_LIST = [...ADAPTER_FAMILIES].join(", ");
