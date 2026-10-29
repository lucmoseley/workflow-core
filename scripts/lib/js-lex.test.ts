// @vitest-environment node
/*
 * The bracket and argument scanner test-read-edges.js reads source through
 * (#1770): a bracket or comma inside a string, comment or regex literal must
 * never count, or a call's arguments are split wrong and its reads lost.
 */

import { describe, expect, it } from "vitest";
import { closeOf, inertSpans, statementEnd, topLevelArgs } from "./js-lex.js";

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

	it("closes a quoted string at its line, so an apostrophe in JSX text hides no bracket below (#3659)", () => {
		const text = "f(<p>don't</p>,\n x)";
		expect(closeOf(text, 1)).toBe(text.length);
	});

	it("reads from a bracket inside a template's text as code, skipping the strings there (#3667)", () => {
		const text = 'const fx = `const d = path.join(root, "a)b");`;';
		expect(closeOf(text, text.indexOf("("))).toBe(text.indexOf(";"));
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

	it("reads from inside a template's placeholder as code (#3667)", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: JS source under test, not a template
		const text = 'x = `a ${f(";")} b`; y(1)';
		expect(statementEnd(text, text.indexOf("f"))).toBe(text.length);
	});

	it("runs to the end of a text with no `;`", () => {
		expect(statementEnd("a = b\n", 0)).toBe(6);
	});
});

describe("inertSpans", () => {
	it("gives each string, comment and regex its first and last index, a template whole (#3667)", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: JS source under test, not a template
		const text = 'return /a/g; `${"b"}`; // c';
		expect(
			inertSpans(text).map(([first, last]) => text.slice(first, last + 1)),
		).toEqual([
			"/a/g",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: JS source under test, not a template
			'`${"b"}`',
			"// c",
		]);
	});
});
