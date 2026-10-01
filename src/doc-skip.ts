// src/doc-skip.ts — the doc-covered substitution test, ported from
// suspenders hooks/lib/knowledge.ts (W103 mechanics, MIT ours) so buckle's
// preseed pipeline can drop rows the lane repo's own docs already teach
// (W94: the agent would pay hub AND files). Self-contained port: no
// cross-repo import; if the source mechanics change, tests pin parity.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SubstitutionDoc {
	path: string;
	text: string;
}

export interface SubstitutionVerdict {
	covered: boolean;
	doc: string | null;
	docText: string | null;
	coverage: number;
	residue: string;
}

export const COVERED_MIN = 0.75; // ≥ share of fact terms in one file → covered
const SENTENCE_KEEP_MAX = 0.55; // sentence survives when its own coverage < this

// closed-class words any fact and any doc share — excluded so coverage
// measures content overlap only
const STOP = new Set(
	"the and for with that this from are was were not but all any can has had its one two per via when then than into only also may will must should would could have been each which their what how why get use used using same even never every always note see like just more less most over under after before does done keep keeps kept row rows".split(
		" ",
	),
);

export function distinctTerms(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9_.-]+/)
			// sentence punctuation would glue to tokens ("teaches." ≠ "teaches")
			.map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
			.filter((t) => t.length > 2 && !STOP.has(t)),
	);
}

function coverageOf(terms: Set<string>, hay: Set<string>): number {
	if (!terms.size) return 0;
	let hit = 0;
	for (const t of terms) if (hay.has(t)) hit++;
	return hit / terms.size;
}

export function substitutionCheck(
	fact: string,
	docs: SubstitutionDoc[],
	coveredMin = COVERED_MIN,
): SubstitutionVerdict {
	const v: SubstitutionVerdict = {
		covered: false,
		doc: null,
		docText: null,
		coverage: 0,
		residue: "",
	};
	const terms = distinctTerms(fact);
	if (docs.length < 1 || terms.size < 4) return v; // thin fact, no signal
	let bestDoc: { doc: string; text: string; cov: number } | null = null;
	for (const d of docs) {
		const hay = distinctTerms(d.text);
		if (!hay.size) continue;
		const cov = coverageOf(terms, hay);
		if (!bestDoc || cov > bestDoc.cov)
			bestDoc = { doc: d.path, text: d.text, cov };
	}
	if (!bestDoc || bestDoc.cov < coveredMin) return v;
	const docTerms = distinctTerms(bestDoc.text);
	const residue = fact
		.split(/(?<=[.;!?])\s+/)
		.map((s) => s.trim())
		.filter(
			(s) => s && coverageOf(distinctTerms(s), docTerms) < SENTENCE_KEEP_MAX,
		)
		.join(" ");
	return {
		...v,
		covered: true,
		doc: bestDoc.doc,
		docText: bestDoc.text,
		coverage: bestDoc.cov,
		residue,
	};
}

export const MAX_DOCS = 300; // corpus cap — a huge repo cannot stall ingest
export const MAX_DOC_BYTES = 262_144;

// docs corpus for the substitution test: docs/ (recursive .md/.markdown) plus
// root-level README/AGENTS/CLAUDE/NOTICE. Paths relative to root.
export function loadDocs(root: string): SubstitutionDoc[] {
	const out: SubstitutionDoc[] = [];
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e);
			try {
				const st = statSync(p);
				if (st.isDirectory()) walk(p);
				else if (e.endsWith(".md") || e.endsWith(".markdown"))
					out.push({
						path: p.slice(root.length + 1),
						text: readFileSync(p, "utf8"),
					});
			} catch {}
		}
	};
	walk(join(root, "docs"));
	for (const f of ["README.md", "AGENTS.md", "CLAUDE.md", "NOTICE.md"]) {
		try {
			out.push({ path: f, text: readFileSync(join(root, f), "utf8") });
		} catch {}
	}
	return out;
}
