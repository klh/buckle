// src/gov/federation-entitlements.ts — W154 echo menu: the hub-entitled
// model menu a spoke belt mirrors. Sourced from the hub upstream pool;
// per-group capability tags give tier. Visibility law: a `visibility:
// spoke-private` deployment marker excludes the group defensively (the
// structural exclusion is stronger: spoke-local pools simply are not in the
// hub pool). Dormant groups (no deployments) are cloud tiers by the
// upstreams contract — `available: false`, locality "cloud".
import type { UpstreamPool } from "../upstreams.ts";

export interface EntitlementModel {
	id: string;
	family: string | null;
	tier: string;
	locality: "cloud" | "hub-local";
	available: boolean;
}

function isLoopback(url: string): boolean {
	try {
		const { hostname } = new URL(url);
		return (
			hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost"
		);
	} catch {
		return false;
	}
}

/** Hub-entitled models: pool groups minus spoke-private markers. */
export function buildModels(
	pool: UpstreamPool,
	tags: Record<string, string[]> = {},
): EntitlementModel[] {
	const models: EntitlementModel[] = [];
	for (const group of pool.groups()) {
		const deps = pool.deployments(group);
		if (deps.some((d) => d.visibility === "spoke-private")) continue;
		const live = deps.filter((d) => d.url.length > 0);
		const anyCloud = live.some((d) => !isLoopback(d.url));
		const groupTags = tags[group] ?? [];
		const tier = groupTags.includes("frontier")
			? "frontier"
			: groupTags.includes("local")
				? "local"
				: "general";
		const locality = live.length === 0 || anyCloud ? "cloud" : "hub-local";
		models.push({
			id: group,
			family: live[0]?.adapter ?? null,
			tier,
			locality,
			available: live.length > 0,
		});
	}
	return models;
}
