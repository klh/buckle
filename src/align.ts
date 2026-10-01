// src/align.ts — W142 cache-align (W137 §3b, cloud half): opt-in prompt-cache
// alignment on EXPLICITLY declared requests only. Pass-through doctrine:
// without the x-belt-aids declaration the body is never touched. Layout
// doctrine: tools → system(static) → shared packet cards → per-lane brief
// (volatile last), one cache_control breakpoint after the shared/static
// prefix — a breakpoint inside volatile content would make every request a
// 1.25x cache WRITE instead of a 0.1x read.
import type { Dialect } from "./upstreams.ts";

/** The packet header belt splices after the stable prefix. */
export const PACKET_MARKER = "[fleet preseed";

type AnyRec = Record<string, unknown>;

export interface AlignResult {
	/** The aligned body, or null when nothing changed (idempotent no-op). */
	body: Record<string, unknown> | null;
	placed: "system" | "packet" | "none";
}

/** Find the last message content block carrying the packet marker. */
function packetBlock(body: AnyRec): AnyRec | null {
	const messages = body.messages;
	if (!Array.isArray(messages)) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as AnyRec;
		const content = m.content;
		if (!Array.isArray(content)) continue;
		for (let j = content.length - 1; j >= 0; j--) {
			const b = content[j] as AnyRec;
			if (typeof b.text === "string" && b.text.includes(PACKET_MARKER))
				return b;
		}
	}
	return null;
}

/** Normalize system to a block array with exactly ONE cache_control
 *  breakpoint on the last block; strips misplaced pre-existing ones.
 *  Returns null when nothing changed (already aligned / no system). */
function systemBlocks(body: AnyRec): boolean {
	const sys = body.system;
	if (typeof sys === "string") {
		body.system = [
			{ type: "text", text: sys, cache_control: { type: "ephemeral" } },
		];
		return true;
	}
	if (Array.isArray(sys) && sys.length > 0) {
		const last = sys[sys.length - 1] as AnyRec;
		if (last.cache_control) return false; // already aligned
		for (const b of sys as AnyRec[]) delete b.cache_control;
		last.cache_control = { type: "ephemeral" };
		return true;
	}
	return false;
}

/** Align one request body (anthropic dialect): breakpoint after the packet
 *  block when present, else after the system prefix. Returns null when the
 *  body was already aligned (idempotent) or nothing could be aligned. */
export function alignBody(body: AnyRec, dialect: Dialect): AlignResult | null {
	if (dialect !== "anthropic") return null;
	const pb = packetBlock(body);
	if (pb && !pb.cache_control) {
		pb.cache_control = { type: "ephemeral" };
		return { body, placed: "packet" };
	}
	if (pb) return null; // packet block already carries the breakpoint
	if (!systemBlocks(body)) return null;
	return { body, placed: "system" };
}
