// @vitest-environment node
/*
 * lib/strip-comments.js's contract: comments go, literals stay whole, and the
 * scan's literals are the outermost ones, whatever a regex literal or a
 * template placeholder holds (#3001). Its callers judge code by what is left:
 * a comment read as code reports a flag nobody reads in check-cli-args.js,
 * and a literal cut short hides a core's refusal from the REPRINTED check.
 */

import { describe, expect, it } from "vitest";
import { scanJs, stripComments } from "./strip-comments.js";

describe("stripComments", () => {
	it("drops line and block comments and keeps a comment opener inside a string", () => {
		expect(stripComments('a /* c */ "/* k */" // x\nb')).toBe(
			'a  "/* k */" \nb',
		);
	});

	it("reads a quote inside a regex literal as no string (#3001)", () => {
		expect(stripComments("const r = /[$`'\"]/; /* gone */ x")).toBe(
			"const r = /[$`'\"]/;  x",
		);
	});

	it("reads a slash after a name as division", () => {
		expect(stripComments("const h = w / 2; // gone\nk")).toBe(
			"const h = w / 2; \nk",
		);
	});
});

describe("scanJs", () => {
	it("returns a template whole, the literals in its placeholders inside it", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: JS source under test, not a template
		const source = 'f(`a ${b ? `x${"y"}` : "z"} c`, "d")';
		expect(scanJs(source).literals.map((l) => l.raw)).toEqual([
			// biome-ignore lint/suspicious/noTemplateCurlyInString: JS source under test, not a template
			'`a ${b ? `x${"y"}` : "z"} c`',
			'"d"',
		]);
	});

	it("places each literal at its offset in the source", () => {
		const source = 'x = "a"; /* "no" */ y = `b`';
		for (const { at, raw } of scanJs(source).literals)
			expect(source.slice(at, at + raw.length)).toBe(raw);
		expect(scanJs(source).literals).toHaveLength(2);
	});
});
