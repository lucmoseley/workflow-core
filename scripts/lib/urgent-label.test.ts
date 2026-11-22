// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isPassingDown } from "./urgent-label.js";

describe("a sub-issue chain's tiers (#3653)", () => {
	it("pass through an open issue and stop at a closed one", () => {
		expect(isPassingDown({ state: "open" })).toBe(true);
		expect(isPassingDown({ state: "closed" })).toBe(false);
	});
});
