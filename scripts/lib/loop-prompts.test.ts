import { describe, expect, it } from "vitest";
import { hasNothingToRepeat, parkedPromptOf } from "./loop-prompts.js";

describe("a parked session's resume, by the block its marker names (#3949)", () => {
	it.each(["API_ERROR", "LIMIT"])("%s has nothing to repeat", (cause) => {
		expect(hasNothingToRepeat(cause)).toBe(true);
		expect(parkedPromptOf(cause)).toContain("continue your task");
	});

	it("a permission park is told to repeat its call", () => {
		expect(hasNothingToRepeat("PERMISSION")).toBe(false);
		expect(parkedPromptOf("PERMISSION")).toContain(
			"Repeat the tool call that raised it",
		);
	});

	it.each(["QUESTION", "a cause no prompt knows", undefined])(
		"%s points at what it left standing",
		(cause) => {
			expect(hasNothingToRepeat(cause)).toBe(false);
			expect(parkedPromptOf(cause)).toContain("the founder may be back");
		},
	);
});
