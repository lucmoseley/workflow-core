// @vitest-environment node
/*
 * lib/cut-at.js's contract (#1344): the text before the first separator and
 * the text after it, with "" after where there is no separator — the pair
 * `split(sep)` gives as its first element and the rest rejoined. In-process,
 * since the helper is a pure function. A wrong cut moves bytes between a
 * header and its body in every parser that calls it.
 */

import { describe, expect, it } from "vitest";
import { cutAt } from "./cut-at.js";

describe("cutAt", () => {
	it("cuts at the first separator only", () => {
		expect(cutAt("a\nb\nc", "\n")).toEqual(["a", "b\nc"]);
	});

	it("returns the whole string and an empty tail where there is no separator", () => {
		expect(cutAt("abc", "\n")).toEqual(["abc", ""]);
	});

	it("steps over a separator longer than one character", () => {
		expect(cutAt("k=>v=>w", "=>")).toEqual(["k", "v=>w"]);
	});

	it("matches split's first element on an empty head", () => {
		expect(cutAt("=v", "=")).toEqual(["", "v"]);
		expect(cutAt("", "=")).toEqual(["", ""]);
	});
});
