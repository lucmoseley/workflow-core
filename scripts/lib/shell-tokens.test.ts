// @vitest-environment node
/*
 * lib/shell-tokens.js's `tokenise` (#3445): the words a command's text makes.
 * The check_staged classifier reads Biome's flags from them, so a word read
 * wrong there maps or refuses a command on text the shell never runs.
 */

import { describe, expect, it } from "vitest";
import { tokenise } from "./shell-tokens.js";

/** The value of each word token `src` makes. */
const values = (src: string) =>
	tokenise(src).flatMap((t) => (t.type === "word" ? [t.value] : []));

describe("tokenise — an unclosed double quote ending in a backslash (#3546)", () => {
	it("keeps the trailing backslash as text, appending nothing after it", () => {
		expect(values('echo "a\\')).toEqual(["echo", "a\\"]);
	});
});

describe("tokenise — a backslash inside double quotes", () => {
	it("escapes a quote, keeping it in the word", () => {
		expect(values('echo "a\\"b"')).toEqual(["echo", 'a"b']);
	});
});

describe("tokenise — $(( arithmetic or a subshell (#3546)", () => {
	it("reads $((…)) as one arithmetic expansion, holding no commands", () => {
		const [, word] = tokenise("echo $((1+(2)))");
		expect(word).toMatchObject({ type: "word", pieces: ["", null, ""] });
		expect(word?.type === "word" && word.subs).toEqual([]);
	});

	it("reads a $(( whose first ( closes before its last as a command substitution", () => {
		const [, word] = tokenise("echo $((cd /; biome) )");
		const subs = word?.type === "word" ? word.subs : [];
		expect(subs).toHaveLength(1);
		expect(
			subs[0]?.flatMap((t) => (t.type === "word" ? [t.value] : [])),
		).toEqual(["cd", "/", "biome"]);
	});

	it("reads an unclosed $(( as a command substitution", () => {
		const [, word] = tokenise("echo $(( (a))");
		expect(word?.type === "word" && word.subs).toHaveLength(1);
	});
});
