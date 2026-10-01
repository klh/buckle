// src/sse.ts — SSE sniffing for the usage tee. A line-oriented parser
// consuming the tee'd sniff branch of the upstream body; the client branch
// is never touched by this code (byte identity is structural: tee()).
// Usage semantics ported from LiteLLM 1.103.0 streaming_handler.py (MIT):
// extract usage even when the caller never asked — include_usage only
// controls what the caller sees; anthropic usage rides message_start
// (input side, incl. cache columns) and the cumulative output_tokens on
// message_delta. Keep-alive comment lines (`: ping`) pass through the
// client branch verbatim and are ignored here.
import type { Dialect } from "./upstreams.ts";
import { usageFromAnthropic, usageFromOpenAI, type Usage } from "./usage.ts";

type AnyRec = Record<string, unknown>;

/** Consumes upstream SSE bytes, extracts usage. Emits nothing downstream. */
export class SseSniffer {
	private buf = "";
	private eventType = "";
	private start: Usage | null = null;
	private deltaOut = 0;
	private openai: Usage | null = null;

	constructor(private readonly dialect: Dialect) {}

	/** Feed the next byte chunk. */
	push(chunk: Uint8Array | string): void {
		this.buf +=
			typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		let idx = this.buf.indexOf("\n");
		while (idx >= 0) {
			this.line(this.buf.slice(0, idx).replace(/\r$/, ""));
			this.buf = this.buf.slice(idx + 1);
			idx = this.buf.indexOf("\n");
		}
	}

	/** Final flush at stream end (a tail line without trailing newline). */
	flush(): void {
		if (this.buf.length > 0) {
			this.line(this.buf.replace(/\r$/, ""));
			this.buf = "";
		}
	}

	private line(line: string): void {
		if (line.startsWith(":")) return; // keep-alive comment
		if (line.startsWith("event:")) {
			this.eventType = line.slice(6).trim();
			return;
		}
		if (!line.startsWith("data:")) return;
		const payload = line.slice(5).trim();
		if (payload.length === 0 || payload === "[DONE]") return;
		try {
			this.data(JSON.parse(payload));
		} catch {
			// non-JSON data line: not usage-bearing, ignore honestly
		}
	}

	private data(json: unknown): void {
		if (!json || typeof json !== "object") return;
		const r = json as AnyRec;
		if (this.dialect === "anthropic") {
			const t = typeof r.type === "string" ? r.type : this.eventType;
			if (t === "message_start") {
				const msg = (r.message ?? {}) as AnyRec;
				const u = usageFromAnthropic(msg.usage);
				if (u !== null) this.start = u;
			} else if (t === "message_delta") {
				const u = usageFromAnthropic(r.usage);
				if (u !== null && u.out_tok > this.deltaOut) this.deltaOut = u.out_tok;
			}
			return;
		}
		const u = usageFromOpenAI(r.usage);
		if (u !== null) this.openai = u; // last chunk wins
	}

	/** Extracted usage, or null = honest unknown (nothing was seen). */
	usage(): Usage | null {
		if (this.dialect === "anthropic") {
			if (this.start === null && this.deltaOut === 0) return null;
			return {
				in_tok: this.start?.in_tok ?? 0,
				out_tok: Math.max(this.deltaOut, this.start?.out_tok ?? 0),
				cache_r: this.start?.cache_r ?? 0,
				cache_c: this.start?.cache_c ?? 0,
			};
		}
		return this.openai;
	}
}
