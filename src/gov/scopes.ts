// src/gov/scopes.ts — W141 role/scope naming: `buckle:<resource>:<role>`
// where the role segment carries the coarse READ_/WRITE_ prefix. WRITE_
// implies READ_ (same resource); READ_ implies nothing. Root principals
// get the explicit full list — no wildcard magic, inspectable strings only.

export const SCOPE_RE = /^buckle:[a-z_]+:(READ_|WRITE_)$/;

export type BuckleResource = "proxy" | "admin" | "spoke";

/** All four concrete scopes; root = this exact list, no wildcards.
 *  W154 adds the spoke pair: federation pull surfaces (policy manifest,
 *  entitlements) and CR delivery confirmation read/write as a spoke. */
export const ALL_SCOPES: readonly string[] = [
	"buckle:proxy:READ_",
	"buckle:proxy:WRITE_",
	"buckle:admin:READ_",
	"buckle:admin:WRITE_",
	"buckle:spoke:READ_",
	"buckle:spoke:WRITE_",
];

/** Normalize+validate one scope string; null when not buckle-shaped. */
export function parseScope(raw: string): string | null {
	const s = raw.trim();
	return SCOPE_RE.test(s) ? s : null;
}

/** Scope list from the storage form (space-separated): invalid entries are
 *  reported to the caller (dropped), never smuggled in as valid scopes. */
export function scopesFromStorage(raw: string | null): {
	scopes: string[];
	dropped: string[];
} {
	const dropped: string[] = [];
	const scopes: string[] = [];
	for (const part of (raw ?? "").split(/\s+/)) {
		if (part.length === 0) continue;
		const ok = parseScope(part);
		if (ok === null) dropped.push(part);
		else scopes.push(ok);
	}
	return { scopes, dropped };
}

/** WRITE_ implies READ_ on the same resource; exact match always passes. */
export function scopeImplies(holder: string, needed: string): boolean {
	const h = parseScope(holder);
	const n = parseScope(needed);
	if (h === null || n === null) return false;
	if (h === n) return true;
	const hp = h.split(":");
	const np = n.split(":");
	if (hp[1] !== np[1]) return false;
	return hp[2] === "WRITE_" && np[2] === "READ_";
}

/** Does the holder set satisfy `needed` (with WRITE_⊃READ_ inheritance)? */
export function hasScope(scopes: string[], needed: string): boolean {
	return scopes.some((s) => scopeImplies(s, needed));
}

/** Storage form: space-separated, sorted, deduped (hash-friendly, diffable). */
export function scopesToStorage(scopes: string[]): string {
	const valid = [...new Set(scopes.map(parseScope))].filter(
		(s): s is string => s !== null,
	);
	return [...valid].sort().join(" ");
}
