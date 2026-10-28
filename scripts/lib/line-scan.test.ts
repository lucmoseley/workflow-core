// @vitest-environment node
/*
 * lib/line-scan.js's contract: each parser finds exactly the matches of the
 * regex it stands in for (#3383), and does so in linear time. The parsers
 * feed check-guard-registry.js's dependency digest, so a parser that found
 * one path more or less would move a guard's digest, or miss the lib edit
 * the digest is there to warn about.
 */

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

interface Match {
	prefix: string;
	value: string;
}
const { parseNodeRuns, parseNodeVars, parseSourcedLibs, segmentTailMatches } =
	require("./line-scan.js") as {
		parseSourcedLibs: (text: string) => string[];
		parseNodeRuns: (text: string) => Match[];
		parseNodeVars: (text: string) => Match[];
		segmentTailMatches: (
			text: string,
			head: RegExp,
			tail: RegExp,
			stops: string,
		) => { index: number; head: RegExpExecArray; tail: RegExpExecArray }[];
	};

const SOURCE_RE =
	/^[^#\n]*?(?:^|\s)(?:source|\.)\s+[^\n]*?(lib\/[\w.-]+\.sh)/gm;
const NODE_RUN_RE =
	/^([^#\n]*?)(?:^|[\s(|;&])node\s+"?\$[^\n]*?\/([\w-][\w./-]*\.js)/gm;
const NODE_VAR_RE =
	/^([^#\n]*?)(?:^|[\s(|;&])node\s+"?\$\{?(\w+)\}?(?=["\s;|)]|$)/gm;

const groups = (re: RegExp, text: string): Match[] =>
	[...text.matchAll(re)].map((m) => ({
		prefix: m[1] ?? "",
		value: m[2] ?? "",
	}));

const PLANTED = [
	'source "$here/lib/guard-log.sh"',
	". lib/a.sh.sh # lib/b.sh",
	"x source lib/a.sh; source lib/b.sh",
	"# source lib/a.sh",
	"source\tlib/a-b.c.sh\r. lib/c.sh",
	"sourcelib/a.sh",
	"source lib/.sh lib/x.sh",
	'node "$here/session-arbiter.js" "$@"',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
	"(node $root/scripts/a/b.js) | node ${x}/c.js",
	'// node "$here/x.js"',
	"node $x/-a.js node $y/.js",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
	'node "$lib"; node ${prog} | node $a}x',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
	'if node $script; then node "${b}"',
	"node $\nnode $x",
	"a&node $v)",
];

describe("parseSourcedLibs", () => {
	it.each(PLANTED)("matches the regex it stands in for on %j", (text) => {
		expect(parseSourcedLibs(text)).toEqual(
			[...text.matchAll(SOURCE_RE)].map((m) => m[1]),
		);
	});

	it("takes the longest name ending in .sh, the first on the line", () => {
		expect(parseSourcedLibs("source $d/lib/a.sh.sh lib/b.sh")).toEqual([
			"lib/a.sh.sh",
		]);
	});
});

describe("parseNodeRuns", () => {
	it.each(PLANTED)("matches the regex it stands in for on %j", (text) => {
		expect(parseNodeRuns(text)).toEqual(groups(NODE_RUN_RE, text));
	});

	it("returns the text before node with the path after the slash", () => {
		expect(parseNodeRuns('x; node "$here/a/b.js"')).toEqual([
			{ prefix: "x;", value: "a/b.js" },
		]);
	});
});

describe("parseNodeVars", () => {
	it.each(PLANTED)("matches the regex it stands in for on %j", (text) => {
		expect(parseNodeVars(text)).toEqual(groups(NODE_VAR_RE, text));
	});
});

describe("segmentTailMatches", () => {
	const head = /\b(?:const|let)\s+(\w+)\s*=\s*(?!\s)/g;
	const tail = /[^;\n]*"([\w./-]+\.js)"/y;
	const whole = /\b(?:const|let)\s+(\w+)\s*=\s*(?!\s)[^;\n]*"([\w./-]+\.js)"/g;

	it.each([
		'const a = "x.js"; let b = f("y.js", "z.js")',
		'let a = let b = "x.js"',
		'const a = 1; const b = "x.js"\nlet c = "y.js";',
		'const a =\n  "x.js"',
	])("matches the one regex of head and tail on %j", (text) => {
		expect(
			segmentTailMatches(text, head, tail, ";\n").map((m) => [
				m.index,
				m.head[1],
				m.tail[1],
			]),
		).toEqual([...text.matchAll(whole)].map((m) => [m.index, m[1], m[2]]));
	});
});

// A regex match is synchronous, so only a process timeout can stop a
// backtracking one (#2188): each oracle above takes over 10 s on these
// texts, a linear read well under one. A `\r` opens a line for `^` but does
// not end the prefix, so each one is a fresh start.
describe("a long line of heads that reach nothing", () => {
	it.each([
		["parseSourcedLibs", "source ".repeat(80_000)],
		["parseNodeRuns", 'node "$/a '.repeat(55_000)],
		["parseNodeVars", "node $-\r".repeat(30_000)],
	])("%s reads it in linear time", (name, text) => {
		const r = spawnSync(
			process.execPath,
			[
				"-e",
				`const found = require(${JSON.stringify(require.resolve("./line-scan.js"))})[process.argv[1]](require("node:fs").readFileSync(0, "utf8")); process.exit(found.length === 0 ? 0 : 1)`,
				name,
			],
			{ input: text, timeout: 10_000 },
		);
		expect(r.signal).toBeNull();
		expect(r.status).toBe(0);
	});
});
