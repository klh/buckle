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
import { type Usage, usageFromAnthropic, usageFromOpenAI } from "./usage.ts";

type AnyRec = Record<string, unknown>;

/** Consumes upstream SSE bytes, extracts usage. Emits nothing downstream. */
export class SseSniffer {
	private buf = "";
	private eventType = "";
	/** data: lines of the event being assembled (joined with \n at dispatch) */
	private dataLines: string[] = [];
	/** ONE streaming decoder: a multibyte char split across chunks survives */
	private readonly decoder = new TextDecoder();
	private start: Usage | null = null;
	private deltaOut = 0;
	private openai: Usage | null = null;

	constructor(private readonly dialect: Dialect) {}

	/** Feed the next byte chunk. */
	push(chunk: Uint8Array | string): void {
		this.buf +=
			typeof chunk === "string"
				? chunk
				: this.decoder.decode(chunk, { stream: true });
		let idx = this.buf.indexOf("\n");
		while (idx >= 0) {
			this.line(this.buf.slice(0, idx).replace(/\r$/, ""));
			this.buf = this.buf.slice(idx + 1);
			idx = this.buf.indexOf("\n");
		}
	}

	/** Final flush at stream end: decoder tail, a tail line without
	 *  trailing newline, and an event never closed by a blank line. */
	flush(): void {
		this.buf += this.decoder.decode();
		if (this.buf.length > 0) {
			this.line(this.buf.replace(/\r$/, ""));
			this.buf = "";
		}
		this.dispatch();
	}

	/** One SSE line (WHATWG event-stream field rules). */
	private line(line: string): void {
		if (line.length === 0) {
			this.dispatch(); // blank line = event boundary
			return;
		}
		if (line.startsWith(":")) return; // keep-alive comment
		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") this.eventType = value.trim();
		else if (field === "data") this.dataLines.push(value);
	}

	/** Event boundary: join the data lines, parse, then reset event state. */
	private dispatch(): void {
		const payload = this.dataLines.join("\n").trim();
		this.dataLines = [];
		try {
			if (payload.length > 0 && payload !== "[DONE]")
				this.data(JSON.parse(payload));
		} catch {
			// non-JSON data: not usage-bearing, ignore honestly
		}
		this.eventType = "";
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
				// cumulative input side may ride message_delta (the cross-dialect
				// bridge always puts it there; newer anthropic wires do too)
				if (u !== null && u.in_tok > (this.start?.in_tok ?? 0))
					this.start = {
						in_tok: u.in_tok,
						out_tok: this.start?.out_tok ?? 0,
						cache_r: this.start?.cache_r ?? 0,
						cache_c: this.start?.cache_c ?? 0,
					};
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
