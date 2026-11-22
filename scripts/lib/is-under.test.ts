// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isUnder, relativeUnder } from "./is-under.js";

describe("isUnder", () => {
	it("holds a path equal to a root", () => {
		expect(isUnder("docs", ["docs"])).toBe(true);
	});

	it("holds a path beneath a root", () => {
		expect(isUnder("docs/a/b.md", ["CLAUDE.md", "docs"])).toBe(true);
	});

	it("refuses a sibling sharing the root's prefix", () => {
		expect(isUnder("docsx/a", ["docs"])).toBe(false);
	});

	it("refuses every path where there are no roots", () => {
		expect(isUnder("docs", [])).toBe(false);
	});

	it("splits on the separator it is given", () => {
		expect(isUnder("docs\\a", ["docs"], "\\")).toBe(true);
		expect(isUnder("docs\\a", ["docs"])).toBe(false);
	});
});

describe("relativeUnder", () => {
	it("answers the empty path for the root itself", () => {
		expect(relativeUnder("/r", "/r")).toBe("");
	});

	it("answers the relative path for a path beneath the root", () => {
		expect(relativeUnder("/r", "/r/a/b")).toBe("a/b");
	});

	it("holds a name starting with two dots inside the root (#4021)", () => {
		expect(relativeUnder("/r", "/r/..foo")).toBe("..foo");
	});

	it("refuses the parent and a path through it", () => {
		expect(relativeUnder("/r", "/")).toBeNull();
		expect(relativeUnder("/r/a", "/r/x")).toBeNull();
	});

	it("refuses a sibling sharing the root's prefix", () => {
		expect(relativeUnder("/r", "/rx/a")).toBeNull();
	});
});
