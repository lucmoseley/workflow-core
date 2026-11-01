// @vitest-environment node
/*
 * lib/shell-tokens.js's `tokenise` (#3445): the words a command's text makes.
 * The check_staged classifier reads Biome's flags from them, so a word read
 * wrong there maps or refuses a command on text the shell never runs. Each
 * row hands `tokenise` the text alone, with no shell and no repo, so a failure
 * is the lexing's and never a classifier rule's above it.
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

describe("tokenise — a `$'…'` control escape (#3853)", () => {
	it.each([
		["$'\\cA'", "\x01"],
		["$'\\c'", "\\c"],
		["$'a\\c'", "a\\c"],
	])("reads %s as bash does", (src, value) => {
		expect(values(src)).toEqual([value]);
	});
});

/* Each row's bytes are what `bash -c "printf %s <src>"` printed, on bash 5.2.21
 * in C.UTF-8. A row expects them as Node decodes bytes: not UTF-8, U+FFFD. */
describe("tokenise — a `$'…'` word reads as bash's bytes (#3896)", () => {
	it.each<[string, number[]]>([
		["$'\\x'", [0x5c, 0x78]],
		["$'\\xZ'", [0x5c, 0x78, 0x5a]],
		["$'\\u'", [0x5c, 0x75]],
		["$'\\uZ'", [0x5c, 0x75, 0x5a]],
		["$'\\U'", [0x5c, 0x55]],
		["$'\\UZ'", [0x5c, 0x55, 0x5a]],
		["$'\\U110000'", [0xf4, 0x90, 0x80, 0x80]],
		["$'\\U00200000'", [0xf8, 0x88, 0x80, 0x80, 0x80]],
		["$'\\U7FFFFFFF'", [0xfd, 0xbf, 0xbf, 0xbf, 0xbf, 0xbf]],
		["$'b\\UFFFFFFFFc'", [0x62, 0x63]],
		["$'\\uD800'", [0xed, 0xa0, 0x80]],
		["$'\\u7ff'", [0xdf, 0xbf]],
		["$'\\u800'", [0xe0, 0xa0, 0x80]],
		["$'\\U0001F600'", [0xf0, 0x9f, 0x98, 0x80]],
		["$'\\q'", [0x5c, 0x71]],
		["$'\\8'", [0x5c, 0x38]],
		["$'\\\u00e9'", [0x5c, 0xc3, 0xa9]],
		["$'\\\\'", [0x5c]],
		["$'\\''", [0x27]],
		["$'\\\"'", [0x22]],
		["$'\\?'", [0x3f]],
		["$'\\xFF'", [0xff]],
		["$'\\xc3\\xa9'", [0xc3, 0xa9]],
		["$'\\303\\251'", [0xc3, 0xa9]],
		["$'\\777'", [0xff]],
		["$'\\x414'", [0x41, 0x34]],
		["$'\\1012'", [0x41, 0x32]],
		["$'\\x{41}'", [0x41]],
		["$'\\x{41'", [0x41]],
		["$'\\x{4142}'", [0x42]],
		["$'\\c?'", [0x7f]],
		["$'\\c\\\\A'", [0x1c, 0x41]],
		["$'\\c\\A'", [0x1c, 0x41]],
		["$'\\c\u00e9'", [0x03, 0xa9]],
	])("reads %s", (src, bytes) => {
		expect(values(src)).toEqual([Buffer.from(bytes).toString()]);
	});

	it.each([
		"a$'b\\0c'd",
		"a$'b\\x00c'd",
		"a$'b\\c@c'd",
		"a$'b\\400c'd",
		"a$'b\\u0'd",
		"a$'b\\U0'd",
		"a$'b\\x{}c'd",
		"a$'b\\x{Zc'd",
	])("ends the quoted span at the NUL in %s", (src) => {
		expect(values(src)).toEqual(["abd"]);
	});
});

describe("tokenise — a glob (#3851)", () => {
	const word = (src: string) => tokenise(src)[0];

	it.each(["bi?me", "bi*", "bi[o]me"])("marks %s, keeping its text", (src) => {
		expect(word(src)).toMatchObject({ value: src, glob: true });
	});

	it.each(["[", "biome", "'bi?me'", "bi\\?me", '"bi*"', "$?"])(
		"leaves %s unmarked",
		(src) => {
			expect(word(src)).toMatchObject({ glob: false });
		},
	);
});
