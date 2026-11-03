// @vitest-environment node
/*
 * Pins the one test of how far a tier passes down a sub-issue chain (#3653),
 * shared by pick-next.js and file-issue.js. Were it to pass through a closed
 * issue, file-issue would refuse an `urgent` nothing passes down.
 */
import { describe, expect, it } from "vitest";
import { isPassingDown } from "./urgent-label.js";

describe("a sub-issue chain's tiers (#3653)", () => {
	it("pass through an open issue and stop at a closed one", () => {
		expect(isPassingDown({ state: "open" })).toBe(true);
		expect(isPassingDown({ state: "closed" })).toBe(false);
	});
});
