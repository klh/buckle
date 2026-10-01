// src/complexity.ts — belt's 7-dimension complexity scorer, ported verbatim
// from bin/router-shim.ts (zero LLM: regexps + arithmetic only, W136 §5.1).
// Weights/thresholds unchanged: SIMPLE < 0.15 ≤ MEDIUM < 0.35 ≤ COMPLEX <
// 0.6 ≤ VERY_COMPLEX; the code-presence clamp (code tasks ride MEDIUM so
// they reach the coder) unchanged. Input: the flattened user-message text,
// capped at the first 8,000 chars — deterministic, microseconds.

export type ComplexityTier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "VERY_COMPLEX";

export const TIER_THRESHOLDS = { SIMPLE: 0.15, MEDIUM: 0.35, COMPLEX: 0.6 };

const CODE_PATTERNS =
	/\b(function|class|interface|type\s|const\s|let\s|var\s|import\s|export\s|def\s|public\s|private\s|async\s|await|return|=>|\.ts|\.tsx|\.js|\.py|\.cs|typescript|javascript|python|csharp|refactor|debug|compile|lint|api|endpoint|component|hook|docker|kubernetes|algorithm|implement|optimize)\b/i;

const REASONING_MARKERS =
	/\b(analyze|explain|compare|evaluate|design|architect|strategy|why|how\s+does|what\s+if|pros\s+and\s+cons|trade.?off|implications|consequences|root\s+cause|derive|prove|justify|critique)\b/i;

const TECHNICAL_TERMS =
	/\b(distributed|concurrency|latency|throughput|scalab|migration|protocol|authentication|encryption|database|schema|middleware|microservice|monolith|event.?driven|state\s+machine|compiler|runtime|garbage\s+collection)\b/i;

const SIMPLE_INDICATORS =
	/^(reply|respond|list|name|give\s+me|tell\s+me|what\s+is|who\s+is|when\s+is|where\s+is|how\s+many|convert|translate|summarize\s+this|format\s+this|sort\s+this)\b/i;

const MULTI_STEP =
	/\b(first.*then|step\s+\d|also\s+after|additionally|furthermore|meanwhile|subsequently|before\s+that|after\s+that|next\s+you|finally)\b/i;

const QUESTION_DEPTH =
	/\b(underlying|fundamental|philosophical|theoretical|abstract|conceptual|architectural|systemic|holistic|nuanced|paradox|dilemma|emergence)\b/i;

export interface ComplexityScore {
	total: number; // 0..1 (higher = more complex)
	tier: ComplexityTier;
	dimensions: Record<string, number>;
}

const WEIGHTS: Record<string, number> = {
	tokenCount: 0.15,
	codePresence: 0.25,
	reasoningMarkers: 0.25,
	technicalTerms: 0.1,
	simpleIndicators: 0.1,
	multiStep: 0.05,
	questionComplexity: 0.1,
};

/** The scorer, verbatim: dimension clamps → weighted sum → tier, with the
 *  code-presence clamp (code tasks ride MEDIUM) last. */
export function scoreComplexity(text: string): ComplexityScore {
	const lower = text.toLowerCase();
	const words = text.split(/\s+/).length;
	const dimensions: Record<string, number> = {
		tokenCount: Math.min(words / 200, 1),
		codePresence: CODE_PATTERNS.test(text) ? 0.8 : 0,
		reasoningMarkers:
			(lower.match(new RegExp(REASONING_MARKERS.source, "gi")) ?? []).length *
			0.25,
		technicalTerms:
			(lower.match(new RegExp(TECHNICAL_TERMS.source, "gi")) ?? []).length *
			0.2,
		simpleIndicators: SIMPLE_INDICATORS.test(text.trim()) ? -0.3 : 0, // NEGATIVE weight
		multiStep: MULTI_STEP.test(lower) ? 0.3 : 0,
		questionComplexity: QUESTION_DEPTH.test(lower) ? 0.4 : 0,
	};
	for (const k of Object.keys(dimensions)) {
		dimensions[k] = Math.max(0, Math.min(1, dimensions[k] ?? 0));
	}
	let total = 0;
	for (const [dim, weight] of Object.entries(WEIGHTS)) {
		total += (dimensions[dim] ?? 0) * weight;
	}
	return finishComplexity(total, dimensions);
}

/** Total clamp → tier (the code clamp last), belt verbatim. */
function finishComplexity(
	total: number,
	dimensions: Record<string, number>,
): ComplexityScore {
	total = Math.max(0, Math.min(1, total));
	// code tasks always route to coder regardless of complexity
	if ((dimensions.codePresence ?? 0) > 0.5) {
		return { total, tier: "MEDIUM", dimensions };
	}
	let tier: ComplexityTier;
	if (total < TIER_THRESHOLDS.SIMPLE) tier = "SIMPLE";
	else if (total < TIER_THRESHOLDS.MEDIUM) tier = "MEDIUM";
	else if (total < TIER_THRESHOLDS.COMPLEX) tier = "COMPLEX";
	else tier = "VERY_COMPLEX";
	return { total, tier, dimensions };
}

/** Flatten the request's messages (belt's blocksOf), capped at 8,000
 *  chars — the classifier's only input. */
export function textFromMessages(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	const parts: string[] = [];
	for (const m of messages) {
		const content = (m as { content?: unknown } | null)?.content;
		if (typeof content === "string") parts.push(content);
		else if (Array.isArray(content)) {
			for (const b of content) {
				const t = (b as { text?: unknown } | null)?.text;
				if (typeof t === "string") parts.push(t);
			}
		}
	}
	return parts.join(" ").slice(0, 8000);
}
