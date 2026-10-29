/*
 * sh-quote.test.ts — scripts/lib/sh-quote.js (#3483): which words go bare, and
 * that every word reaches a real sh as the one word it was. The round trip
 * runs a real sh, since the shape of a quoted word is sh's to judge, not a
 * regex's; broken, a printed retry line or hook body splits or expands a word.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellQuote } from "./sh-quote.js";

describe("shellQuote", () => {
	it("leaves a word of safe characters bare", () => {
		expect(shellQuote("scripts/watch-artefact.js")).toBe(
			"scripts/watch-artefact.js",
		);
		expect(shellQuote("--label=kind:ticket,x@y%z+1")).toBe(
			"--label=kind:ticket,x@y%z+1",
		);
	});

	it("single-quotes any other word, the empty one included", () => {
		expect(shellQuote("")).toBe("''");
		expect(shellQuote("a b")).toBe("'a b'");
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
		expect(shellQuote("issues?state=open&per_page=100")).toBe(
			"'issues?state=open&per_page=100'",
		);
	});

	it("hands sh each word back unchanged", () => {
		const words = ["", "plain", "a b", "it's", "$HOME", "*", "`x`", "a\nb"];
		const out = execFileSync(
			"sh",
			["-c", `printf '%s\\0' ${words.map(shellQuote).join(" ")}`],
			{ encoding: "utf8" },
		);
		expect(out.split("\0").slice(0, -1)).toEqual(words);
	});

	it("quotes every ~, so bash expands none (#2284)", () => {
		const words = ["~/x", "a=~/x", "HEAD~1", "PATH=a:~/b"];
		const out = execFileSync(
			"bash",
			["-c", `printf '%s\\0' ${words.map(shellQuote).join(" ")}`],
			{ encoding: "utf8" },
		);
		expect(out.split("\0").slice(0, -1)).toEqual(words);
	});
});
