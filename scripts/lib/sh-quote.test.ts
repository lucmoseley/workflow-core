import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellQuote } from "./sh-quote.js";

const roundTrip = (shell: string, words: string[]) =>
	execFileSync(
		shell,
		["-c", `printf '%s\\0' ${words.map(shellQuote).join(" ")}`],
		{ encoding: "utf8" },
	)
		.split("\0")
		.slice(0, -1);

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
		expect(roundTrip("sh", words)).toEqual(words);
	});

	it("leaves a ref or script name bare, a ~ in it included (#2284)", () => {
		for (const word of ["HEAD~1", "test:changed", "--full=flake"]) {
			expect(shellQuote(word)).toBe(word);
		}
	});

	it("quotes a ~ bash would expand, and bash reads every ~ back as written (#2284)", () => {
		for (const word of ["~/x", "a=~/x", "PATH=a:~/b"]) {
			expect(shellQuote(word)).toBe(`'${word}'`);
		}
		const words = ["~/x", "a=~/x", "HEAD~1", "PATH=a:~/b"];
		expect(roundTrip("bash", words)).toEqual(words);
	});
});
