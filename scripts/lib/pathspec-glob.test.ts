// @vitest-environment node

import { describe, expect, it } from "vitest";
import { globMatches } from "./pathspec-glob.js";

describe("globMatches bracket classes", () => {
	it("never matches a slash through a bracket class", () => {
		expect(globMatches("a[/]b", "a/b")).toBe(false);
	});

	it("never matches a slash through a negated bracket class", () => {
		expect(globMatches("a[!x]b", "a/b")).toBe(false);
		expect(globMatches("a[!x]b", "a-b")).toBe(true);
	});

	it("reads a bracket that never closes as a literal", () => {
		expect(globMatches("a[b*", "a[bc")).toBe(true);
	});
});
