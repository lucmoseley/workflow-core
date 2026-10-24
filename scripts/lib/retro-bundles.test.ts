// @vitest-environment node
/*
 * retro-bundles.test.ts — the bundling rule alone, on plain issue objects:
 * the runs of 1, 8 and 9 #1105's criteria name, and what is not a finding.
 * pick-next.test.ts covers the slot and floor accounting the run builds on it.
 * Plain objects because the rule is a pure function of the issue list: each
 * case states the exact run it means, with no `gh` stub or tracker between,
 * and a bundling fault cannot hide behind a slot-accounting one.
 *
 * Break it and a retro run launches one /triage session per finding again,
 * or one bundle past the cap of 8, which #1105 set against a session's context.
 */
import { describe, expect, it } from "vitest";

const { retroBundles } = require("./retro-bundles.js");

const MARK = "Standalone: retro-sweep finding (#948)";
const finding = (number: number) => ({
	number,
	takes: ["triage"],
	body: `**Retro category:** x\n\n${MARK}\n`,
});
const run = (n: number) =>
	Array.from({ length: n }, (_, k) => finding(1000 + k));

describe("retroBundles", () => {
	it("launches a run of 1 as one bundle of 1", () => {
		expect(retroBundles(run(1))).toEqual([[1000]]);
	});

	it("launches a run of 8 as one bundle of 8", () => {
		const bundles = retroBundles(run(8));
		expect(bundles).toHaveLength(1);
		expect(bundles[0]).toHaveLength(8);
	});

	it("splits a run of 9 into two bundles, balanced and in filing order", () => {
		expect(retroBundles(run(9))).toEqual([
			[1000, 1001, 1002, 1003, 1004],
			[1005, 1006, 1007, 1008],
		]);
	});

	it("yields ceil(N/8) bundles of at most 8 for every N up to 40", () => {
		for (let n = 0; n <= 40; n++) {
			const bundles = retroBundles(run(n));
			expect(bundles).toHaveLength(Math.ceil(n / 8));
			expect(bundles.flat()).toHaveLength(n);
			for (const b of bundles) expect(b.length).toBeLessThanOrEqual(8);
		}
	});

	it("leaves non-retro takes:triage issues out, so they launch singly", () => {
		const other = { number: 5, takes: ["triage"], body: "Standalone: other" };
		const wayfinder = { ...finding(6), takes: ["wayfinder"] };
		const doubled = { ...finding(7), takes: ["triage", "implement"] };
		expect(retroBundles([other, wayfinder, doubled, finding(8)])).toEqual([
			[8],
		]);
	});

	it("reads an adopter's finding, whose spec is repo-qualified", () => {
		const adopter = {
			number: 3,
			takes: ["triage"],
			body: "Standalone: retro-sweep finding (lucmoseley/workflow-core-tracker#948)",
		};
		expect(retroBundles([adopter])).toEqual([[3]]);
	});
});
