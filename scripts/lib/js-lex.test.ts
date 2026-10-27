// @vitest-environment node
/*
 * The bracket and argument scanner test-read-edges.js reads source through
 * (#1770): a bracket or comma inside a string, comment or regex literal must
 * never count, or a call's arguments are split wrong and its reads lost.
 */

import { describe, expect, it } from "vitest";
import {
	blankComments,
	closeOf,
	statementEnd,
	topLevelArgs,
} from "./js-lex.js";

describe("closeOf", () => {
	it("finds the bracket closing the one at the index, past nested ones", () => {
		const text = "f(a(b), [c])+1";
		expect(closeOf(text, 1)).toBe(12);
	});

	it("skips brackets inside strings, comments and regex literals", () => {
		const text = 'f(")", /* ) */ /\\)[)]/, // )\n x)';
		expect(closeOf(text, 1)).toBe(text.length);
	});

	it("reads a / after a value as division, not a regex", () => {
		expect(closeOf("f(a / b, c)", 1)).toBe(11);
	});

	it("returns -1 for a bracket never closed", () => {
		expect(closeOf("f(a, b", 1)).toBe(-1);
	});
});

describe("topLevelArgs", () => {
	it("splits at top-level commas only, trimming each argument", () => {
		expect(topLevelArgs(' a, g(b, c), "d,e", [f, g], { h: 1, i: 2 } ')).toEqual(
			["a", "g(b, c)", '"d,e"', "[f, g]", "{ h: 1, i: 2 }"],
		);
	});

	it("keeps a comma inside a regex literal within its argument", () => {
		expect(topLevelArgs("x, /a,b/.test(y)")).toEqual(["x", "/a,b/.test(y)"]);
	});

	it("returns nothing for an empty list", () => {
		expect(topLevelArgs("  ")).toEqual([]);
	});
});

describe("statementEnd", () => {
	it("ends just past the first top-level `;`, past brackets and literals", () => {
		const text = 'const a = f(";", { b: 1; }, /;/) + `;`;\nnext;';
		expect(statementEnd(text, 0)).toBe(text.indexOf("\n"));
	});

	it("runs to the end of a text with no `;`", () => {
		expect(statementEnd("a = b\n", 0)).toBe(6);
	});
});

describe("blankComments", () => {
	it("blanks line and block comments, keeping offsets and line breaks", () => {
		const text = 'a("x"); // "y"\n/* "z"\n */ b(/\\//);';
		const out = blankComments(text);
		expect(out).toHaveLength(text.length);
		expect(out.split("\n")).toHaveLength(3);
		expect(out).toContain('a("x");');
		expect(out).toContain("b(/\\//);");
		expect(out).not.toMatch(/"[yz]"/);
	});

	it("leaves a comment opener inside a string alone", () => {
		expect(blankComments('f("a // b")')).toBe('f("a // b")');
	});
});
