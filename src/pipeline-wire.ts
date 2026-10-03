// src/pipeline-wire.ts — W5 prompt pipeline IN, wire seam. Response-side
// sideband: called after the usage row lands on non-streaming proxied
// responses. NEVER mutates the served bytes — the byte-identity law
// outranks the pipeline. One metered aid event per declared request; every
// skip has a named reason.
import type { AidsLedger } from "./aids.ts";
import type { Servicemon } from "./servicemon.ts";
import { condenseText, extractText, type CondenseStore } from "./pipeline.ts";

const DEFAULT_MAX_BYTES = 262144;

export interface CondenseInboundDeps {
	pipeline?: CondenseStore;
	aidsPolicy: {
		"condense-in"?: { default?: "on" | "off"; max_bytes?: number };
	};
	aids: Pick<AidsLedger, "record">;
	sm: Servicemon;
}

export function condenseInbound(
	deps: CondenseInboundDeps,
	ctx: { rid: string; dialect: "openai" | "anthropic"; condenseIn: boolean },
	parsed: unknown,
): void {
	if (!ctx.condenseIn) return; // never declared → zero touch, not metered
	const meter = (decision: "injected" | "skipped", reason?: string): void => {
		deps.aids.record({
			ts: Date.now(),
			aid: "condense-in",
			decision,
			skip_reason: reason ?? null,
		});
	};
	const skip = (reason: string): void => {
		meter("skipped", reason);
		deps.sm
			.counter(
				"buckle_pipeline_condense_total",
				"W5 inbound condense outcomes on declared requests.",
			)
			.inc({ outcome: "skipped", reason });
	};
	if (!deps.pipeline) {
		skip("unavailable");
		return;
	}
	if (deps.aidsPolicy["condense-in"]?.default === "off") {
		skip("policy");
		return;
	}
	const text = extractText(ctx.dialect, parsed);
	if (!text) {
		skip("no_text");
		return;
	}
	const maxBytes =
		deps.aidsPolicy["condense-in"]?.max_bytes ?? DEFAULT_MAX_BYTES;
	if (Buffer.byteLength(text) > maxBytes) {
		skip("too_large");
		return;
	}
	const condensed = condenseText(text);
	if (condensed.rules.length === 0 || condensed.text === text) {
		skip("no_gain");
		return;
	}
	deps.pipeline.put({
		rid: ctx.rid,
		dialect: ctx.dialect,
		condensed: condensed.text,
		raw: text,
		rules: condensed.rules,
	});
	meter("injected");
	deps.sm
		.counter(
			"buckle_pipeline_condense_total",
			"W5 inbound condense outcomes on declared requests.",
		)
		.inc({ outcome: "stored" });
}
