// @vitest-environment node
/*
 * lib/is-under.js's contract (#1647). In-process, since the helper is a pure
 * function. A wrong answer widens or narrows the skeleton pathspec, the
 * doc-map's scope, what the release ships and the needle corpus at once.
 */

import { describe, expect, it } from "vitest";
import { isUnder } from "./is-under.js";

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
