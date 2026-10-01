// test/cooldown-eject.test.ts — allowed_fails ejection + recovery.
import { describe, expect, test } from "bun:test";
import { Cooldowns } from "../src/cooldown.ts";

const mkDep = (group: string, url: string) => ({
	group,
	url,
	dialect: "openai" as const,
});

describe("Cooldowns", () => {
	test("benches after allowed_fails consecutive failures", () => {
		const t = 1000;
		const cd = new Cooldowns(3, 30, () => t);
		const d = mkDep("g", "http://x");
		cd.failure(d);
		cd.failure(d);
		expect(cd.benched(d)).toBe(false);
		cd.failure(d);
		expect(cd.benched(d)).toBe(true);
	});

	test("success resets the consecutive-failure counter", () => {
		const t = 1000;
		const cd = new Cooldowns(3, 30, () => t);
		const d = mkDep("g", "http://x");
		cd.failure(d);
		cd.failure(d);
		cd.success(d);
		cd.failure(d);
		cd.failure(d);
		expect(cd.benched(d)).toBe(false);
	});

	test("recovers when the cooldown window passes", () => {
		let t = 1000;
		const cd = new Cooldowns(3, 30, () => t);
		const d = mkDep("g", "http://x");
		for (let i = 0; i < 3; i++) cd.failure(d);
		expect(cd.benched(d)).toBe(true);
		t += 30_000;
		expect(cd.benched(d)).toBe(false);
	});
});
