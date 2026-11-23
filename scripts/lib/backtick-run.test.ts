import { describe, expect, it } from "vitest";
import { runEnd } from "./backtick-run.js";

describe("runEnd", () => {
	it("returns the index past the backtick run starting at the given index", () => {
		expect(runEnd("a```b", 1)).toBe(4);
	});

	it("stops at the end of the line", () => {
		expect(runEnd("x``", 1)).toBe(3);
	});

	it("returns the start where no backtick sits there", () => {
		expect(runEnd("abc", 1)).toBe(1);
	});
});
