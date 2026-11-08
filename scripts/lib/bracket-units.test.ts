// @vitest-environment node
/*
 * lib/bracket-units.js's contract: it splits a pattern into exactly the units
 * the alternation `/\[[^\]]*\]|./gs` would match, in one pass (#3383, #4109).
 * token-shapes.js builds every token regex from these units and
 * infer-commands.js reads a glob by them, so a unit split one character off
 * changes what the secret masker catches.
 */

import { describe, expect, it } from "vitest";
import { bracketUnits } from "./bracket-units.js";

describe("bracketUnits", () => {
	it("reads a closed class as one unit and every other character alone", () => {
		expect(bracketUnits("b[io]ome*")).toEqual([
			"b",
			"[io]",
			"o",
			"m",
			"e",
			"*",
		]);
	});

	it("reads an unclosed [ as itself", () => {
		expect(bracketUnits("a[b")).toEqual(["a", "[", "b"]);
		expect(bracketUnits("[a]]")).toEqual(["[a]", "]"]);
	});

	it("agrees with the alternation on every short pattern of [, ], a and b", () => {
		const alphabet = "[]ab";
		for (let n = 0; n < 2000; n++) {
			let s = "";
			const len = n % 9;
			for (let k = 0; k < len; k++)
				s += alphabet[(n * 7 + k * 13 + ((n >> k) & 3)) % alphabet.length];
			expect(bracketUnits(s)).toEqual(s.match(/\[[^\]]*\]|./gs) ?? []);
		}
	});

	it("reads a long run of unclosed [ as single units (#3383)", () => {
		expect(bracketUnits(`${"[".repeat(100_000)}]`)).toHaveLength(1);
		expect(bracketUnits(`]${"[".repeat(100_000)}`)).toHaveLength(100_001);
	});
});
