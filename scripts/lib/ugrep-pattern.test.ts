// @vitest-environment node
/*
 * lib/ugrep-pattern.js, the guard-ugrep-pattern core (#2801), in process: it
 * warns, never denying, when a bare `grep` pattern carries a ranged repeat
 * that Claude Code's bundled ugrep may refuse (#1021).
 *
 * The first fire case and the first two pass cases are #1021's acceptance
 * criteria; do not thin them.
 *
 * Which grep fires, and with which sentence, is read off the command alone;
 * the latch on disk, the core-path rewrite and the payload faults are
 * guard-ugrep-pattern.test.ts's boundary set.
 */

import { describe, expect, it } from "vitest";
import { kitContextFake } from "./kit-context-fake";

interface Decision {
	injectRules: string[];
	prelude: string;
	latchAfter: string;
	deny?: string;
}
const { decide } = require("./ugrep-pattern.js") as {
	decide: (command: string, ctx: object) => Decision | null;
};

const HEAD =
	'`grep` here is Claude Code\'s bundled ugrep, and a bounded repeat in its pattern — `.{0,80}`, say — can make it refuse the pattern with `exceeds complexity limits` or stall on a long line (#1021). A refused pattern exits 2, not 1: exit 2 is no verdict, never "no match".';
const SILENCED =
	" This command discards stderr, which is what hides the refusal.";
const TAIL =
	"\n\nRe-spell it as the same command with `-P` in place of `-E`, or added where there is neither, every other flag kept and the backslashes taken off a `\\{N,M\\}`. A pattern of literals, `.`, bracket classes and bounded repeats prints what the refused command would have; an alternation, or a basic-mode `( ) | + ?`, can match differently under `-P`. Or use `rg` or python. Warned once a session; docs/agents/tool-output.md.";

/** The kit's context, its latch unspent unless `told`, its rewrite the
 *  identity unless `corePaths` is given. */
const ctx = ({
	told = false,
	corePaths = (t: string) => t,
	vars = {},
}: {
	told?: boolean;
	corePaths?: (t: string) => string;
	vars?: Record<string, string>;
} = {}) =>
	kitContextFake({
		told: (id: string) => {
			expect(id).toBe("ugrep-pattern");
			return told;
		},
		corePaths,
		cwd: "/work",
		fallbackCwd: "/hook",
		vars,
		log: () => {
			throw new Error("the core logs nothing");
		},
	});

/** The note the core hands over for `command`, or null. */
const run = (command: string, at = ctx()) => {
	const d = decide(command, at);
	if (!d) return null;
	expect(d.deny).toBeUndefined();
	expect(d.injectRules).toEqual([]);
	expect(d.latchAfter).toBe("ugrep-pattern");
	return d.prelude;
};

describe("a bounded repeat ugrep may refuse is warned on", () => {
	it("names ugrep, exit 2, -P and the discarded stderr", () => {
		const note = run('grep -o -h -E ".{0,80}(x|y).{0,80}" f 2>/dev/null');
		expect(note).toContain("ugrep");
		expect(note).toContain("exits 2");
		expect(note).toContain("`-P` in place of `-E`");
		expect(note).toContain("every other flag kept");
		expect(note).toContain("an alternation");
		expect(note).toContain("discards stderr");
	});

	it("is the note byte for byte, the stderr sentence after the head", () => {
		expect(run('grep -oE "a{1,3}" f 2>/dev/null')).toBe(
			`${HEAD}${SILENCED}${TAIL}`,
		);
		expect(run('grep -oE "a{1,3}" f')).toBe(`${HEAD}${TAIL}`);
	});

	it("hands the note through the core-path rewrite", () => {
		const note = run(
			'grep -oE "a{1,3}" f',
			ctx({ corePaths: (t) => t.replace("docs/", "/plugin/docs/") }),
		);
		expect(note).toContain("Warned once a session; /plugin/docs/agents/");
	});

	it("leaves out the stderr sentence where stderr is kept", () => {
		const note = run('grep -o -E ".{0,20}x.{0,20}" f');
		expect(note).toContain("ugrep");
		expect(note).not.toContain("discards stderr");
	});

	it.each([
		'grep -oE "a{1,3}" f >/dev/null 2>&1',
		'grep -oE "a{1,3}" f &>/dev/null',
		'grep -oE "a{1,3}" f 2>&-',
		'grep -oE "a{1,3}" f 2> /dev/null | head',
		'grep -oE "a{1,3}" f 2>>/dev/null',
		'grep -oE "a{1,3}" f &>>/dev/null',
		// A second stdout redirect elsewhere is undone by a later /dev/null.
		'grep -oE "a{1,3}" f >x >/dev/null 2>&1',
		// Stderr sent elsewhere, then copied onto a /dev/null stdout.
		'grep -oE "a{1,3}" f >/dev/null 2>x 2>&1',
		// One firing grep discarding stderr is enough, wherever it stands.
		'grep -oE "a{1,3}" f 2>/dev/null; grep -oE "b{1,3}" g',
		'grep -oE "a{1,3}" f; grep -oE "b{1,3}" g 2>/dev/null',
	])("says stderr is discarded: %s", (command) => {
		expect(run(command)).toContain("discards stderr");
	});

	it.each([
		'grep -oE "a{1,3}" f 2>&1 | head',
		'ls 2>/dev/null; grep -oE "a{1,3}" f',
		'grep -oE "a{1,3}" f; ls >/dev/null 2>&1',
		// Read in the order written: stderr went to the old stdout first.
		'grep -oE "a{1,3}" f 2>&1 >/dev/null',
		// Stdout moved off /dev/null again before the copy.
		'grep -oE "a{1,3}" f >/dev/null >x 2>&1',
		// Stdout to /dev/null and stderr copied to another descriptor.
		'grep -oE "a{1,3}" f >/dev/null 2>&3',
		// Stdout moved onto stderr, so the copy follows it there (#2801).
		'grep -oE "a{1,3}" f >/dev/null 1>&2 2>&1',
		// A clobber to /dev/null is not one of the read spellings.
		'grep -oE "a{1,3}" f 2>|/dev/null',
		// Stderr to a file named 1, or read from /dev/null, is kept.
		'grep -oE "a{1,3}" f >/dev/null 2>1',
		'grep -oE "a{1,3}" f 2</dev/null',
		// Stderr to a real file is kept.
		'grep -oE "a{1,3}" f 2>err.log',
		// A /dev/null stdout alone keeps stderr.
		'grep -oE "a{1,3}" f >/dev/null',
		// A grep that passes discarding stderr does not lend it to one that fires.
		'grep -n foo g 2>/dev/null; grep -oE "a{1,3}" f',
	])("says nothing of another command's stderr: %s", (command) => {
		const note = run(command);
		expect(note).toContain("ugrep");
		expect(note).not.toContain("discards stderr");
	});

	it("tells a basic-mode pattern to drop its backslashes under -P", () => {
		expect(run("grep -o '.\\{0,80\\}x' f")).toContain(
			"the backslashes taken off",
		);
	});

	it.each([
		'grep -oE "a{,3}" f',
		'grep -oE "a{2,}" f',
		"grep -o '.\\{0,80\\}x' f",
		"grep -o '.\\{,8\\}x' f",
		"grep -o '.\\{8,\\}x' f",
		'cat f | grep -E -e zz -e "a{1,3}" | head',
		'grep -oEh --include=*.ts "a{1,3}" f',
		'X=1 grep -E "a{1,3}" f',
		// -G after -E is basic mode again.
		"grep -E -G 'a\\{1,3\\}' f",
		// -E after -G is extended again.
		'grep -G -E "a{1,3}" f',
		// The long spellings of -E and of a pattern flag.
		'grep --extended-regexp "a{1,3}" f',
		'grep -E --regexp "a{1,3}" f',
		'grep -E --regexp="a{1,3}" f',
		'grep -E --regexp "a{1,3}" -e foo f',
		// A pattern flag with no value left takes nothing.
		'grep -E "a{1,3}" f -e',
		// ugrep's own value flags, whose values are not the pattern.
		'grep -t cpp -E "a{1,3}" .',
		'grep -E -e zz --and "a{1,3}" f',
		'grep -E -e zz --andnot "a{1,3}" f',
		'grep -E -e zz --not "a{1,3}" f',
		'grep -A 3 -E "a{1,3}" f',
		// A repeat at the very start of the pattern.
		'grep -E "{1,3}" f',
		// The command word quoted is still the word `grep`.
		'g"rep" -E "a{1,3}" f',
		// Inside a subshell, an `if`, and after a `--`.
		'(grep -E "a{1,3}" f)',
		'if grep -qE "a{1,3}" f; then :; fi',
		'grep -E -- "a{1,3}" f',
		// A pattern word whose quoted part holds no expansion.
		"grep -E 'a{1,3}'\"b\" f",
	])("%s", (command) => {
		expect(run(command)).toContain("ugrep");
	});

	it.each([
		// A word it cannot read hands nothing off, whatever it shows.
		'grep -E "a{1,3}" "$Z"',
		'grep -E "a{1,3}" f "-z$X"',
		// The hand-off list is read from the word's start, and `--null` and
		// `--null-data` whole.
		'grep -E "a{1,3}" a-z',
		'grep --nullx -E "a{1,3}" f',
		'grep --null-datax -E "a{1,3}" f',
		// A z in a long flag is no short-flag run.
		'grep --fuzzy -E "a{1,3}" f',
	])("hands nothing off: %s", (command) => {
		expect(run(command)).toContain("ugrep");
	});

	/* ugrep's value flags as the core lists them, bar the pattern and
	 * pattern-file ones cased above: each takes the next word, so a word
	 * after it is never the pattern. */
	it.each(
		"-A -B -C -D -J -K -M -N -O -d -g -m -t --max-count --after-context --before-context --context --directories --devices --jobs --range --file-magic --neg-regexp --file-extension --file-type --glob --iglob --include --exclude --exclude-dir --exclude-from --include-dir --include-from --binary-files".split(
			" ",
		),
	)("%s takes the next word as its value", (flag) => {
		expect(run(`grep -E ${flag} v "a{1,3}" f`)).toContain("ugrep");
	});

	it("passes a single-quoted dollar as the literal it is", () => {
		expect(run("grep -E '$X{1,3}' f")).toContain("ugrep");
	});
});

describe("what passes", () => {
	it.each([
		'grep -o -h -P ".{0,80}(x|y).{0,80}" f 2>/dev/null',
		"grep -n foo f",
		'grep -oP ".{0,80}x" f',
		'grep -E -o ".{0,80}x" -P f',
		'grep -FE "a{1,3}" f',
		'grep -E -G "a{1,3}" f',
		'grep --perl-regexp -E "a{1,3}" f',
		'grep --fixed-strings -E "a{1,3}" f',
		'grep -E --basic-regexp "a{1,3}" f',
		// BRE without the backslashes: ugrep reads the braces literally.
		'grep -o ".{0,80}x.{0,80}" f',
		'grep -E "a{3}" f',
		"grep 'a\\{3\\}' f",
		// An escaped brace is a literal one under ERE.
		'grep -E "a\\{1,3}" f',
		// ERE braces under BRE, BRE braces under ERE.
		"grep -E 'a\\{1,3\\}x' f",
		// Each of these reaches GNU grep, not the function.
		'egrep "a{1,3}" f',
		'xargs grep -E "a{1,3}"',
		'command grep -E "a{1,3}" f',
		'/usr/bin/grep -E "a{1,3}" f',
		'grep -zE "a{1,3}" f',
		'grep -Ez "a{1,3}" f',
		'grep -EZ "a{1,3}" f',
		'grep -Z -E "a{1,3}" f',
		'grep --null -E "a{1,3}" f',
		'grep --null-data -E "a{1,3}" f',
		'grep --config -E "a{1,3}" f',
		'grep --filter=x -E "a{1,3}" f',
		'grep --pager -E "a{1,3}" f',
		'grep --view -E "a{1,3}" f',
		'grep --format-open=x -E "a{1,3}" f',
		'grep ---x -E "a{1,3}" f',
		'grep -@x -E "a{1,3}" f',
		// The hand-off word quoted is still read.
		'grep "-z" -E "a{1,3}" f',
		// The bounded repeat is a file name, the pattern coming by -e.
		'grep -E -e foo "a{1,3}"',
		// An option taking no pattern after the -e leaves it in force (#2801).
		'grep -E -e foo -m 3 "a{1,3}"',
		// A pattern file: nothing on the command is the pattern.
		'grep -E -f pats "a{1,3}"',
		'grep -E --file=pats "a{1,3}"',
		'grep -E -f "a{1,3}"',
		'grep -E --file "a{1,3}"',
		// BRE braces need both backslashes.
		"grep 'a\\{1,3}' f",
		"grep 'a{1,3\\}' f",
		// A pattern holding an unexpanded variable is unjudged.
		'grep -E "$X{1,3}" f',
		'grep -E -e "$X{1,3}" f',
		'echo "grep -E a{1,3}"',
		// The repeat is a second bare word, a file.
		'grep -E foo "a{1,3}"',
		// An empty range is no repeat, in either mode.
		'grep -E "a{,}" f',
		"grep 'a\\{,\\}' f",
		// A hand-off word spanning a newline, as the function's glob reads it.
		'grep -E "a{1,3}" "-x\n-config" f',
		// No pattern at all.
		"grep -E",
	])("%s", (command) => {
		expect(run(command)).toBeNull();
	});

	it("is silent once the session was told", () => {
		expect(run('grep -oE ".{0,80}x.{0,80}" f', ctx({ told: true }))).toBeNull();
	});
});
