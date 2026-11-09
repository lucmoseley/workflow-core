// @vitest-environment node
import { describe, expect, it } from "vitest";
import { expandHome } from "./lib/home-path.js";

describe("expandHome (#4611)", () => {
	it("reads a leading ~/ and a bare ~ against an absolute home", () => {
		expect(expandHome("~/a/b.md", "/home/u")).toBe("/home/u/a/b.md");
		expect(expandHome("~", "/home/u")).toBe("/home/u");
		expect(expandHome("~/x", "/home/u/")).toBe("/home/u/x");
	});

	it("returns any other path as written, ~user included", () => {
		expect(expandHome("/abs/x", undefined)).toBe("/abs/x");
		expect(expandHome("rel/x", "/home/u")).toBe("rel/x");
		expect(expandHome("~user/x", "/home/u")).toBe("~user/x");
	});

	it("is null where home is unset or empty", () => {
		expect(expandHome("~/x", undefined)).toBeNull();
		expect(expandHome("~/x", null)).toBeNull();
		expect(expandHome("~", "")).toBeNull();
	});

	it("is null where home is relative", () => {
		expect(expandHome("~/x", "home/u")).toBeNull();
		expect(expandHome("~", ".")).toBeNull();
	});
});
