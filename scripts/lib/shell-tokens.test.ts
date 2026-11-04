// @vitest-environment node
/*
 * lib/shell-tokens.js's `tokenise` (#3445): the words a command's text makes.
 * The check_staged classifier reads Biome's flags from them, so a word read
 * wrong there maps or refuses a command on text the shell never runs. Each
 * row hands `tokenise` the text alone, with no shell and no repo, so a failure
 * is the lexing's and never a classifier rule's above it.
 */

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	allCommands,
	simpleCommands,
	tokenise,
	writtenCommands,
} from "./shell-tokens.js";

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

describe("tokenise — a brace expansion's cap (#4088)", () => {
	const buildBraces = (n: number) => "{a,b}".repeat(n);
	const buildOpaquePieces = (n: number) => [
		...new Array(n).fill(["", null]).flat(),
		"",
	];

	it("expands up to the cap's 64 words", () => {
		expect(tokenise(buildBraces(6))).toHaveLength(64);
	});

	it("keeps a word past the cap as one word of null pieces", () => {
		const words = tokenise(buildBraces(7));
		expect(words).toHaveLength(1);
		expect(words[0]).toMatchObject({ value: "", pieces: buildOpaquePieces(7) });
	});

	/* 2^24 words cannot fit this heap, so a build of them kills the child. The
	 * 64 MB is a guess at room for the child's start and a capped tokenise. */
	it("reads 24 brace groups in a 64 MB heap, building no words", () => {
		const script = `
			import { tokenise } from ${JSON.stringify(new URL("./shell-tokens.js", import.meta.url).href)};
			console.log(JSON.stringify(tokenise(${JSON.stringify(buildBraces(24))}).map((w) => w.pieces)));
		`;
		const child = spawnSync(
			process.execPath,
			["--max-old-space-size=64", "--input-type=module", "-e", script],
			{ encoding: "utf8" },
		);
		expect(child.stderr).toBe("");
		expect(JSON.parse(child.stdout)).toEqual([buildOpaquePieces(24)]);
	});
});

describe("tokenise — a word's escapes, quotes and expansions read as bash reads them", () => {
	it("joins a line a backslash continues, in a word or a double quote (#4134)", () => {
		expect(values("a\\\nb")).toEqual(["ab"]);
		expect(values('"a\\\nb"')).toEqual(["ab"]);
		expect(values('a\\"\nb')).toEqual(['a"', "b"]);
	});

	it("reads a comment after a continued line as no word (#4134)", () => {
		expect(values("y \\\n# c")).toEqual(["y"]);
	});

	it("keeps a backslash a backslash escapes, marking the word quoted (#4134)", () => {
		expect(values("a\\\\b")).toEqual(["a\\b"]);
		expect(tokenise("\\x")[0]).toMatchObject({ value: "x", quoted: true });
	});

	it("ends a word at an operator after a closed double quote (#4134)", () => {
		expect(values('a "b";c')).toEqual(["a", "b", "c"]);
		expect(tokenise('a "b";c').map((t) => t.type)).toEqual([
			"word",
			"word",
			"op",
			"word",
		]);
	});

	it("reads an expansion as no text beside the text around it (#4134)", () => {
		expect(values('"$E"x')).toEqual(["x"]);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
		expect(values("echo ${X}y")).toEqual(["echo", "y"]);
		expect(values("echo `a` b")).toEqual(["echo", "", "b"]);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
		expect(values("echo ${}; b")).toEqual(["echo", "", "b"]);
	});

	it("ends a subshell after a braced expansion at its own `)` (#4134)", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
		expect(tokenise("( cd ${X} )").at(-1)).toMatchObject({
			type: "op",
			value: ")",
		});
	});

	it("reads a process substitution as an expansion word, not a redirect (#4134)", () => {
		expect(tokenise("diff <(a) <(b)").map((t) => t.type)).toEqual([
			"word",
			"word",
			"word",
		]);
		expect(values("diff <(a) <(b)")).toEqual(["diff", "", ""]);
	});

	it("keeps one command for each substitution a word holds (#4134)", () => {
		const [, word] = tokenise("echo $(id)");
		expect(word.type === "word" && word.subs).toHaveLength(1);
	});

	it("leaves a redirect with no word after it without a target (#4134)", () => {
		expect(tokenise("echo x >").at(-1)).toEqual({
			type: "redirect",
			op: ">",
			target: null,
		});
	});

	it("reads a group's braces as operators (#4134)", () => {
		expect(
			tokenise("{ a; }").map((t) => (t.type === "op" ? t.value : "w")),
		).toEqual(["{", "w", ";", "}"]);
	});

	it("marks no word of a [[ test a glob (#3851)", () => {
		expect(tokenise("[[ a ]]").map((t) => t.type === "word" && t.glob)).toEqual(
			[false, false, false],
		);
	});

	it("marks a brace expansion's words bash-only (#4088)", () => {
		expect(
			tokenise("echo {a,b}").map((t) => t.type === "word" && t.bashOnly),
		).toEqual([false, true, true]);
	});

	it("expands an empty brace member and leaves a sequence or {} as written (#4088)", () => {
		expect(values("echo {,b}")).toEqual(["echo", "b"]);
		expect(values("echo a{1..3} {}")).toEqual(["echo", "a", "{}"]);
	});
});

describe("tokenise — a `$'…'` escape past the ASCII range (#3896)", () => {
	it("reads \\u80 as U+0080's two bytes", () => {
		expect(values("$'\\u80'")).toEqual(["\u0080"]);
	});

	it("drops a \\U past 0x7FFFFFFF and ends the span at \\0 (#3896)", () => {
		expect(values("$'\\U80000000'")).toEqual([""]);
		expect(values("$'\\0ab' x")).toEqual(["", "x"]);
	});
});

describe("the command lists a token list holds", () => {
	const commands = (src: string, read = allCommands) =>
		read(tokenise(src)).map((c) => c.map((w) => w.value).join(" "));

	it("splits at operators, leaving a redirect out of the words (#4134)", () => {
		expect(commands("cmd >f x; b", simpleCommands)).toEqual(["cmd x", "b"]);
	});

	it("adds each substitution's command after the line's own (#3445)", () => {
		expect(commands("echo $(git status)")).toEqual(["echo ", "git status"]);
	});

	it("reads arithmetic as no command (#3546)", () => {
		expect(commands('echo "$((1 + 2))"')).toEqual(["echo "]);
	});

	it("reads a quoted word as no command when only the written ones count (#3545)", () => {
		expect(commands("bash -c 'git status'", writtenCommands)).toEqual([
			"bash -c git status",
		]);
	});
});
