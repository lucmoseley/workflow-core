// @vitest-environment node
/*
 * lib/home-path.js's contract (#4611). In-process, since the helpers are pure
 * functions. A wrong answer misplaces every `~/` path the shell parser, the
 * gh body reader, the tracker's job-dir scan, the seat dirs, the dispatch watch
 * note and `rescue-sessions --from` read.
 */
import { describe, expect, it } from "vitest";
import { expandHome, expandTildeWord } from "./home-path.js";

describe("expandHome", () => {
	it("reads a leading ~/ and a bare ~ against an absolute home", () => {
		expect(expandHome("~/a/b.md", "/home/u")).toBe("/home/u/a/b.md");
		expect(expandHome("~", "/home/u")).toBe("/home/u");
		expect(expandHome("~/x", "/home/u/")).toBe("/home/u/x");
		expect(expandHome("~", "/")).toBe("/");
		expect(expandHome("~/x", "/")).toBe("/x");
	});

	it("never folds a .. the shell has yet to resolve", () => {
		expect(expandHome("~/a/../b", "/home/u")).toBe("/home/u/a/../b");
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

describe("expandTildeWord", () => {
	it("refuses ~user and an unexpandable ~, passes other words through", () => {
		expect(expandTildeWord("~user/x", "/home/u")).toBeNull();
		expect(expandTildeWord("~/x", undefined)).toBeNull();
		expect(expandTildeWord("~/x", "/home/u")).toBe("/home/u/x");
		expect(expandTildeWord("a/~", "/home/u")).toBe("a/~");
	});
});
