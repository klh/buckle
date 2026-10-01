// src/adapters/tools.ts — THE cross-dialect tool transform (W134 §5): the
// only module allowed to know both vocabularies (openai tool_calls ↔
// anthropic tool_use); pass-through families import nothing from here.
// Field tables + streaming event mapping per the design (LiteLLM anchors:
// anthropic/chat/handler.py:837-846 content_block_start tool_use, :628
// input_json_delta). Edge rules are fixture-pinned: parallel-call blocks
// ordered by first-seen index, JSON parse-fail → reject-verbose (requests
// 400 naming the field; in-flight responses degrade to a raw-string text
// block + warning — never a silent mangle). The anthropic→openai streaming
// mirror ("mirrors the table", W134 §5) stays unbuilt until a bridge
// consumer exists — added with its fixtures, not before.
import { type Usage, usageFromAnthropic, usageFromOpenAI } from "../usage.ts";

export interface TransformWarning {
	field: string;
	message: string;
}

/** Request transform result. rejected != null = reject-verbose: the bridge
 *  answers 400 naming the field, never silently mangles. */
export interface RequestTransform {
	body: Record<string, unknown>;
	warnings: TransformWarning[];
	rejected: TransformWarning | null;
}

export interface ResponseTransform {
	message: Record<string, unknown>;
	warnings: TransformWarning[];
}

type AnyRec = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ---- stop-reason / finish-reason maps (W134 §5 table) ----

/** openai finish_reason → anthropic stop_reason. content_filter→refusal
 *  is the honest anthropic enum match; unknowns land on end_turn. */
export function stopReasonFromOpenAI(finish: unknown): string {
	const f = str(finish);
	if (f === "tool_calls" || f === "function_call") return "tool_use";
	if (f === "length") return "max_tokens";
	if (f === "content_filter") return "refusal";
	return "end_turn";
}

/** anthropic stop_reason → openai finish_reason (table mirror). */
export function finishReasonFromAnthropic(stop: unknown): string {
	const s = str(stop);
	if (s === "tool_use") return "tool_calls";
	if (s === "max_tokens") return "length";
	if (s === "refusal") return "content_filter";
	return "stop";
}

/** Anthropic string-or-blocks → plain text (text blocks only; the rest
 *  is the caller's warning problem). */
function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	const parts: string[] = [];
	for (const b of value) {
		const r = (b ?? {}) as AnyRec;
		if (r.type === "text") parts.push(str(r.text));
	}
	return parts.join("");
}

// ---- request direction: anthropic ingress → openai upstream ----

const PASS_THROUGH = new Set([
	"model",
	"max_tokens",
	"temperature",
	"top_p",
	"stream",
]);

/** Anthropic ingress body → openai wire body. tool_result blocks lift into
 *  role:"tool" messages (in block order) ahead of the residual user text
 *  message; thinking/top_k degrade honestly (drop + warning). */
export function requestAnthropicToOpenAI(body: AnyRec): RequestTransform {
	const warnings: TransformWarning[] = [];
	let rejected: TransformWarning | null = null;
	const out: AnyRec = {};
	for (const [key, value] of Object.entries(body)) {
		if (PASS_THROUGH.has(key)) {
			out[key] = value;
		} else if (key === "system") {
			const s = textOf(value);
			if (s.length > 0) out.system = s;
		} else if (key === "stop_sequences") {
			out.stop = value;
		} else if (key === "messages") {
			out.messages = messagesAToO(value, warnings);
		} else if (key === "tools") {
			out.tools = toolsAToO(value);
		} else if (key === "tool_choice") {
			const choice = choiceAToO(value);
			if (choice === null) {
				rejected = {
					field: "tool_choice",
					message: `untranslatable tool_choice ${JSON.stringify(value) ?? ""}`,
				};
			} else {
				out.tool_choice = choice;
			}
		} else if (key === "thinking" || key === "top_k") {
			warnings.push({
				field: key,
				message: "no openai-compat equivalent — honest degrade (dropped)",
			});
		} else {
			rejected = {
				field: key,
				message: "unrecognized field for the openai wire",
			};
		}
	}
	return { body: out, warnings, rejected };
}

/** Anthropic tools[] → openai tools[]. */
function toolsAToO(value: unknown): unknown[] {
	const out: unknown[] = [];
	if (!Array.isArray(value)) return out;
	for (const t of value) {
		const r = (t ?? {}) as AnyRec;
		out.push({
			type: "function",
			function: {
				name: str(r.name),
				description: r.description ?? "",
				parameters: r.input_schema ?? { type: "object" },
			},
		});
	}
	return out;
}

/** Anthropic tool_choice → openai tool_choice; null = untranslatable. */
function choiceAToO(value: unknown): unknown {
	if (!value || typeof value !== "object") return null;
	const r = value as AnyRec;
	if (r.type === "auto") return "auto";
	if (r.type === "any") return "required";
	if (r.type === "tool" && typeof r.name === "string") {
		return { type: "function", function: { name: r.name } };
	}
	return null;
}

/** messages: assistant tool_use → tool_calls; user tool_result blocks →
 *  role:"tool" messages (block order first, residual text after). */
function messagesAToO(value: unknown, warnings: TransformWarning[]): unknown[] {
	const out: unknown[] = [];
	if (!Array.isArray(value)) return out;
	for (const m of value) {
		const r = (m ?? {}) as AnyRec;
		const content = r.content;
		if (!Array.isArray(content)) {
			out.push(m);
			continue;
		}
		const calls: AnyRec[] = [];
		const text: string[] = [];
		const results: AnyRec[] = [];
		for (const b of content) {
			const br = (b ?? {}) as AnyRec;
			if (br.type === "tool_use") {
				calls.push({
					id: str(br.id),
					type: "function",
					function: {
						name: str(br.name),
						arguments: JSON.stringify(br.input ?? {}),
					},
				});
			} else if (br.type === "tool_result") {
				results.push({
					role: "tool",
					tool_call_id: str(br.tool_use_id),
					content: br.content ?? "",
				});
				if (br.is_error === true) {
					warnings.push({
						field: "tool_result.is_error",
						message: "no openai equivalent — forwarded as-is",
					});
				}
			} else if (br.type === "text") {
				text.push(str(br.text));
			} else {
				warnings.push({
					field: `content.${str(br.type)}`,
					message: "block type dropped in translation",
				});
			}
		}
		if (r.role === "assistant") {
			out.push({
				role: "assistant",
				content: text.length > 0 ? text.join("") : null,
				...(calls.length > 0 ? { tool_calls: calls } : {}),
			});
		} else {
			for (const t of results) out.push(t);
			if (text.length > 0) out.push({ role: "user", content: text.join("") });
		}
	}
	return out;
}

// ---- response direction: openai upstream → anthropic client ----

/** openai chat.completion → anthropic message envelope. tool_calls
 *  arguments JSON.parse → input; parse-fail degrades to a raw-string text
 *  block + warning (in-flight responses cannot be 400'd — surfaced, never
 *  mangled). usage zeros are wire-schema minimum (W134 message_start
 *  rule); the ledger stays honest via the tee, not the envelope. */
export function responseOpenAIToAnthropic(resp: AnyRec): ResponseTransform {
	const warnings: TransformWarning[] = [];
	const choices = Array.isArray(resp.choices) ? resp.choices : [];
	const choice = (choices[0] ?? {}) as AnyRec;
	const msg = (choice.message ?? {}) as AnyRec;
	const content: AnyRec[] = [];
	const text = msg.content;
	if (typeof text === "string" && text.length > 0) {
		content.push({ type: "text", text });
	}
	const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
	for (const c of calls) {
		const cr = (c ?? {}) as AnyRec;
		const fn = (cr.function ?? {}) as AnyRec;
		const raw = str(fn.arguments);
		try {
			const input: unknown = JSON.parse(raw);
			content.push({
				type: "tool_use",
				id: str(cr.id),
				name: str(fn.name),
				input,
			});
		} catch {
			content.push({ type: "text", text: raw });
			warnings.push({
				field: `tool_calls[${str(cr.id)}].arguments`,
				message: "unparseable JSON — raw string surfaced as text",
			});
		}
	}
	const u = usageFromOpenAI(resp.usage);
	return {
		message: {
			id: str(resp.id),
			type: "message",
			role: "assistant",
			model: str(resp.model),
			content,
			stop_reason: stopReasonFromOpenAI(choice.finish_reason),
			stop_sequence: null,
			usage: {
				input_tokens: u?.in_tok ?? 0,
				output_tokens: u?.out_tok ?? 0,
			},
		},
		warnings,
	};
}

// ---- response direction: anthropic upstream → openai client ----

/** anthropic message → openai chat.completion (mirror direction). */
export function responseAnthropicToOpenAI(msg: AnyRec): {
	response: AnyRec;
	warnings: TransformWarning[];
} {
	const warnings: TransformWarning[] = [];
	const content = Array.isArray(msg.content) ? msg.content : [];
	const text: string[] = [];
	const calls: AnyRec[] = [];
	for (const b of content) {
		const br = (b ?? {}) as AnyRec;
		if (br.type === "text") {
			text.push(str(br.text));
		} else if (br.type === "tool_use") {
			calls.push({
				id: str(br.id),
				type: "function",
				function: {
					name: str(br.name),
					arguments: JSON.stringify(br.input ?? {}),
				},
			});
		}
	}
	const u = usageFromAnthropic(msg.usage);
	return {
		response: {
			id: str(msg.id),
			object: "chat.completion",
			model: str(msg.model),
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: text.length > 0 ? text.join("") : null,
						...(calls.length > 0 ? { tool_calls: calls } : {}),
					},
					finish_reason: finishReasonFromAnthropic(msg.stop_reason),
				},
			],
			usage: u
				? {
						prompt_tokens: u.in_tok,
						completion_tokens: u.out_tok,
						...(u.cache_r > 0
							? { prompt_tokens_details: { cached_tokens: u.cache_r } }
							: {}),
					}
				: undefined,
		},
		warnings,
	};
}

// ---- request direction: openai ingress → anthropic upstream ----

const OPENAI_DEGRADE = new Set([
	"frequency_penalty",
	"presence_penalty",
	"logprobs",
	"top_logprobs",
	"n",
	"response_format",
	"seed",
	"logit_bias",
]);

/** openai ingress body → anthropic wire body. system role → top-level
 *  system; assistant tool_calls → tool_use blocks (parse-fail on history
 *  arguments = reject-verbose 400 naming the field); role:"tool" →
 *  tool_result; parallel_tool_calls dropped + warned (W134 §5). */
export function requestOpenAIToAnthropic(body: AnyRec): RequestTransform {
	const warnings: TransformWarning[] = [];
	let rejected: TransformWarning | null = null;
	const out: AnyRec = {};
	const { list, system } = messagesOToA(body.messages, (r) => {
		rejected = r;
	});
	if (rejected !== null) return { body: out, warnings, rejected };
	if (system.length > 0) out.system = system.join("\n");
	out.messages = list;
	for (const [key, value] of Object.entries(body)) {
		if (key === "messages") continue;
		if (PASS_THROUGH.has(key)) {
			out[key] = value;
		} else if (key === "tools") {
			out.tools = toolsOToA(value);
		} else if (key === "tool_choice") {
			if (value === "auto") {
				out.tool_choice = { type: "auto" };
			} else if (value === "required") {
				out.tool_choice = { type: "any" };
			} else if (value === "none") {
				delete out.tools;
				warnings.push({
					field: "tool_choice",
					message: '"none" — tools omitted (anthropic none-by-omission)',
				});
			} else if (choiceOToA(value, out)) {
				// named function choice applied
			} else {
				rejected = {
					field: "tool_choice",
					message: `untranslatable tool_choice ${JSON.stringify(value) ?? ""}`,
				};
			}
		} else if (key === "parallel_tool_calls") {
			warnings.push({
				field: key,
				message: "no anthropic equivalent — dropped (W134 §5)",
			});
		} else if (OPENAI_DEGRADE.has(key)) {
			warnings.push({
				field: key,
				message: "no anthropic equivalent — honest degrade (dropped)",
			});
		} else {
			rejected = {
				field: key,
				message: "unrecognized field for the anthropic wire",
			};
		}
	}
	return { body: out, warnings, rejected };
}

/** openai messages[] → anthropic (system collected separately). */
function messagesOToA(
	value: unknown,
	reject: (r: TransformWarning) => void,
): { list: AnyRec[]; system: string[] } {
	const list: AnyRec[] = [];
	const system: string[] = [];
	if (!Array.isArray(value)) return { list, system };
	for (const m of value) {
		const r = (m ?? {}) as AnyRec;
		const role = str(r.role);
		if (role === "system") {
			system.push(str(r.content));
		} else if (role === "tool") {
			list.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: str(r.tool_call_id),
						content: r.content ?? "",
					},
				],
			});
		} else if (role === "assistant") {
			assistantOToA(r, list, reject);
		} else {
			list.push({ role: "user", content: r.content ?? "" });
		}
	}
	return { list, system };
}

/** assistant history entry: content + tool_calls (parse-fail on history
 *  arguments = reject-verbose naming the field — requests can be 400'd,
 *  unlike in-flight responses). */
function assistantOToA(
	r: AnyRec,
	list: AnyRec[],
	reject: (r: TransformWarning) => void,
): void {
	const blocks: AnyRec[] = [];
	if (typeof r.content === "string" && r.content.length > 0) {
		blocks.push({ type: "text", text: r.content });
	}
	const calls = Array.isArray(r.tool_calls) ? r.tool_calls : [];
	for (const c of calls) {
		const cr = (c ?? {}) as AnyRec;
		const fn = (cr.function ?? {}) as AnyRec;
		const raw = str(fn.arguments);
		try {
			blocks.push({
				type: "tool_use",
				id: str(cr.id),
				name: str(fn.name),
				input: JSON.parse(raw) as unknown,
			});
		} catch {
			reject({
				field: `messages[].tool_calls[${str(cr.id)}].function.arguments`,
				message: "unparseable JSON arguments — reject-verbose",
			});
			return;
		}
	}
	list.push({ role: "assistant", content: blocks });
}

/** openai tools[] → anthropic tools[]. */
function toolsOToA(value: unknown): unknown[] {
	const out: unknown[] = [];
	if (!Array.isArray(value)) return out;
	for (const t of value) {
		const r = (t ?? {}) as AnyRec;
		const fn = (r.function ?? {}) as AnyRec;
		out.push({
			name: str(fn.name),
			description: fn.description ?? "",
			input_schema: fn.parameters ?? { type: "object" },
		});
	}
	return out;
}

/** openai named-function tool_choice → anthropic; true = applied. */
function choiceOToA(value: unknown, out: AnyRec): boolean {
	if (!value || typeof value !== "object") return false;
	const fn = (value as AnyRec).function as AnyRec | undefined;
	if (!fn || typeof fn !== "object" || typeof fn.name !== "string") {
		return false;
	}
	out.tool_choice = { type: "tool", name: fn.name };
	return true;
}

// ---- streaming: openai chunks → anthropic events (W134 §5 table) ----

export interface AnthropicEvent {
	event: string;
	data: AnyRec;
}

/** Stateful openai-chunk → anthropic-event transform. Blocks are strictly
 *  sequential; parallel tool calls order blocks by first-seen index; a
 *  fragment for an already-closed block reopens as a new block + warning
 *  (wire stays valid, nothing lost). message_delta + message_stop emit at
 *  flush, exactly once; a stream that never started flushes empty (no
 *  fabricated envelope). */
export class OpenAIToAnthropicStream {
	private started = false;
	private finished = false;
	private blockIndex = 0;
	private activeIndex = -1;
	private activeKind: "text" | "tool" | null = null;
	private toolBlocks = new Map<number, number>();
	/** first-seen identity per openai tool index (reopens reuse it) */
	private identities = new Map<number, { id: string; name: string }>();
	private usage: unknown = null;
	private stopReason: string | null = null;
	private warned = new Set<string>();
	/** Anomaly ledger for the bridge to warn on post-stream. */
	readonly warnings: TransformWarning[] = [];

	private warnOnce(field: string, message: string): void {
		if (this.warned.has(field)) return;
		this.warned.add(field);
		this.warnings.push({ field, message });
	}

	/** Latest upstream usage (terminal chunk), or null — the bridge ledger
	 *  the honest-unknown path reads. */
	seenUsage(): Usage | null {
		return this.usage === null ? null : usageFromOpenAI(this.usage);
	}

	/** Consume one parsed openai chat.completion.chunk. */
	push(chunk: unknown): AnthropicEvent[] {
		const out: AnthropicEvent[] = [];
		if (!chunk || typeof chunk !== "object") return out;
		const r = chunk as AnyRec;
		if (r.usage !== undefined) this.usage = r.usage;
		if (r.error !== undefined) {
			const err = r.error as AnyRec;
			out.push({
				event: "error",
				data: {
					type: "error",
					error: {
						type: "api_error",
						message: str(err?.message) || "upstream stream error",
					},
				},
			});
			return out;
		}
		if (!this.started) {
			this.started = true;
			const u0 = usageFromOpenAI(r.usage);
			out.push(this.messageStart(r, u0?.in_tok ?? 0));
		}
		const choices = Array.isArray(r.choices) ? r.choices : [];
		if (choices.length > 1) {
			this.warnOnce("choices", "n>1 stream — only choices[0] translated");
		}
		const choice = (choices[0] ?? {}) as AnyRec;
		const delta = (choice.delta ?? {}) as AnyRec;
		this.deltaContent(delta, out);
		this.deltaTools(delta, out);
		this.warnReasoning(delta);
		const finish = choice.finish_reason;
		if (finish !== null && finish !== undefined) {
			this.stopReason = stopReasonFromOpenAI(finish);
			this.closeActive(out);
		}
		return out;
	}

	/** text delta: open/reuse the text block, emit content_block_delta. */
	private deltaContent(delta: AnyRec, out: AnthropicEvent[]): void {
		const text = delta.content;
		if (typeof text !== "string" || text.length === 0) return;
		if (this.activeKind !== "text") {
			this.closeActive(out);
			this.startBlock(out, { type: "text", text: "" }, "text");
		}
		out.push({
			event: "content_block_delta",
			data: {
				type: "content_block_delta",
				index: this.activeIndex,
				delta: { type: "text_delta", text },
			},
		});
	}

	/** tool fragments: parallel calls order blocks by first-seen index;
	 *  a fragment for a closed block reopens as a new block + warning. */
	private deltaTools(delta: AnyRec, out: AnthropicEvent[]): void {
		const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
		for (const c of calls) {
			const cr = (c ?? {}) as AnyRec;
			const fn = (cr.function ?? {}) as AnyRec;
			const idx = typeof cr.index === "number" ? cr.index : 0;
			const known = this.toolBlocks.get(idx);
			if (known === undefined) {
				this.startTool(idx, cr, fn, out);
			} else if (known !== this.activeIndex) {
				this.warnOnce(
					`tool_calls[${String(idx)}]`,
					"fragment for closed block — reopened as a new block",
				);
				this.startTool(idx, cr, fn, out);
			}
			const args = fn.arguments;
			if (typeof args === "string" && args.length > 0) {
				out.push({
					event: "input_json_delta",
					data: {
						type: "input_json_delta",
						index: this.toolBlocks.get(idx) ?? -1,
						partial_json: args,
					},
				});
			}
		}
	}

	private warnReasoning(delta: AnyRec): void {
		if (delta.reasoning_content !== undefined) {
			this.warnOnce(
				"delta.reasoning_content",
				"dropped — no anthropic block type",
			);
		}
		if (delta.reasoning !== undefined) {
			this.warnOnce("delta.reasoning", "dropped — no anthropic block type");
		}
	}

	/** End of stream: close any open block, emit message_delta + message_stop
	 *  exactly once. Empty when the stream never started. */
	flush(): AnthropicEvent[] {
		const out: AnthropicEvent[] = [];
		if (!this.started || this.finished) return out;
		this.finished = true;
		this.closeActive(out);
		const u = this.seenUsage();
		out.push({
			event: "message_delta",
			data: {
				type: "message_delta",
				delta: {
					stop_reason: this.stopReason ?? "end_turn",
					stop_sequence: null,
				},
				usage: { output_tokens: u?.out_tok ?? 0 },
			},
		});
		out.push({ event: "message_stop", data: { type: "message_stop" } });
		return out;
	}

	private messageStart(r: AnyRec, inTok: number): AnthropicEvent {
		return {
			event: "message_start",
			data: {
				type: "message_start",
				message: {
					id: str(r.id),
					type: "message",
					role: "assistant",
					model: str(r.model),
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: inTok, output_tokens: 0 },
				},
			},
		};
	}

	private startBlock(
		out: AnthropicEvent[],
		block: AnyRec,
		kind: "text" | "tool",
	): void {
		this.activeIndex = this.blockIndex;
		this.blockIndex = this.activeIndex + 1;
		this.activeKind = kind;
		out.push({
			event: "content_block_start",
			data: {
				type: "content_block_start",
				index: this.activeIndex,
				content_block: block,
			},
		});
	}

	private startTool(
		idx: number,
		cr: AnyRec,
		fn: AnyRec,
		out: AnthropicEvent[],
	): void {
		this.closeActive(out);
		if (!this.identities.has(idx)) {
			this.identities.set(idx, { id: str(cr.id), name: str(fn.name) });
			if (cr.id === undefined) {
				this.warnOnce(
					`tool_calls[${String(idx)}]`,
					"fragment without id — synthesized empty",
				);
			}
		}
		const ident = this.identities.get(idx) as {
			id: string;
			name: string;
		};
		this.startBlock(
			out,
			{ type: "tool_use", id: ident.id, name: ident.name, input: {} },
			"tool",
		);
		this.toolBlocks.set(idx, this.activeIndex);
	}

	private closeActive(out: AnthropicEvent[]): void {
		if (this.activeKind === null) return;
		out.push({
			event: "content_block_stop",
			data: { type: "content_block_stop", index: this.activeIndex },
		});
		this.activeKind = null;
		this.activeIndex = -1;
	}
}
