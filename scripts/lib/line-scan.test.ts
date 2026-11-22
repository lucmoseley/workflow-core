// @vitest-environment node

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const shellVar = (name: string): string => `\${${name}}`;

interface Match {
	prefix: string;
	value: string;
}
interface RunMatch extends Match {
	lead: string;
}
const { parseProgramRuns, parseProgramVars, segmentTailMatches } =
	require("./line-scan.js") as {
		parseProgramRuns: (text: string) => RunMatch[];
		parseProgramVars: (text: string) => Match[];
		segmentTailMatches: (
			text: string,
			head: RegExp,
			tail: RegExp,
			stops: string,
		) => { index: number; head: RegExpExecArray; tail: RegExpExecArray }[];
	};

const RUN_RE =
	/^([^#\n]*?)(?:^|[\s(|;&])(?:node|bash|sh)\s+"?\$([^\n]*?)\/([\w-][\w./-]*\.(?:js|sh))/gm;
const VAR_RE =
	/^([^#\n]*?)(?:^|[\s(|;&])(?:node|bash|sh)\s+"?\$\{?(\w+)\}?(?=["\s;|)]|$)/gm;

const parseGroups = <T>(
	re: RegExp,
	text: string,
	fields: readonly (keyof T & string)[],
): T[] =>
	[...text.matchAll(re)].map(
		(m) => Object.fromEntries(fields.map((f, i) => [f, m[i + 1] ?? ""])) as T,
	);
const parseVarGroups = (text: string) =>
	parseGroups<Match>(VAR_RE, text, ["prefix", "value"]);
const parseRunGroups = (text: string) =>
	parseGroups<RunMatch>(RUN_RE, text, ["prefix", "lead", "value"]);

const PLANTED = [
	'source "$here/lib/guard-log.sh"',
	". lib/a.sh.sh # lib/b.sh",
	"x source lib/a.sh; source lib/b.sh",
	"# source lib/a.sh",
	"source\tlib/a-b.c.sh\r. lib/c.sh",
	"sourcelib/a.sh",
	"source lib/.sh lib/x.sh",
	'node "$here/session-arbiter.js" "$@"',
	`(node $root/scripts/a/b.js) | node ${shellVar("x")}/c.js`,
	'// node "$here/x.js"',
	"node $x/-a.js node $y/.js",
	`node "$lib"; node ${shellVar("prog")} | node $a}x`,
	`if node $script; then node "${shellVar("b")}"`,
	"node $\nnode $x",
	"a&node $v)",
	"x . y source lib/a.sh . lib/b.sh",
	"a\nnode $x/y.js",
	"a #node $x/y.js\nnode $z/w.js",
	"a.b lib/x.sh\nb.c . lib/y.sh",
	"node node $a/b.js node $c/d.js",
	"a\rnode $x/y.js",
	"a\u2028node $v",
	'bash "$scanner" "$1" commit-msg',
	"sh $x/a.sh.js; bash $y/b.js.sh",
	"ssh $x/a.sh; shellcheck $y/b.sh; bash$z/c.sh",
	`hook_bound sh "${shellVar("R:-.")}"/scripts/lib/serialised.sh x`,
];

describe("parseProgramRuns", () => {
	it.each(PLANTED)("matches the regex it stands in for on %j", (text) => {
		expect(parseProgramRuns(text)).toEqual(parseRunGroups(text));
	});

	it("returns the text before node with the path after the slash", () => {
		expect(parseProgramRuns('x; node "$here/a/b.js"')).toEqual([
			{ prefix: "x;", lead: "here", value: "a/b.js" },
		]);
	});
});

describe("parseProgramVars", () => {
	it.each(PLANTED)("matches the regex it stands in for on %j", (text) => {
		expect(parseProgramVars(text)).toEqual(parseVarGroups(text));
	});
});

describe("every parser against its regex over generated texts", () => {
	const Tokens = [
		"source",
		"lib/",
		".sh",
		"node",
		"$",
		'"',
		"#",
		"\n",
		"\r",
		" ",
		"\t",
		".",
		"x",
		"/",
		".js",
		"{",
		"}",
		"a-b",
		"(",
		";",
		"|",
		"&",
		"\u2028",
		"so",
		"no",
		"bash",
		"sh",
	];
	let seed = 11;
	const next = () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
		return seed / 2_147_483_648;
	};
	const texts = Array.from({ length: 5000 }, () =>
		Array.from(
			{ length: 1 + Math.floor(next() * 30) },
			() => Tokens[Math.floor(next() * Tokens.length)],
		).join(""),
	);

	it("finds exactly the oracle's matches on each", () => {
		const off = texts.filter(
			(t) =>
				JSON.stringify(parseProgramRuns(t)) !==
					JSON.stringify(parseRunGroups(t)) ||
				JSON.stringify(parseProgramVars(t)) !==
					JSON.stringify(parseVarGroups(t)),
		);
		expect(off).toEqual([]);
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

// guess, #4181
const RUN_HEADS = 55_000;
// guess, #4181
const VAR_HEADS = 30_000;
// guess, #4181
const PARSER_TIMEOUT_MS = 10_000;

describe("a long line of heads that reach nothing", () => {
	it.each([
		["parseProgramRuns", "node", 'node "$/a '.repeat(RUN_HEADS)],
		["parseProgramVars", "node", "node $-\r".repeat(VAR_HEADS)],
		["parseProgramRuns", "sh", 'sh "$/a '.repeat(RUN_HEADS)],
	])("%s reads a line of %s heads in linear time", (name, _runner, text) => {
		const r = spawnSync(
			process.execPath,
			[
				"-e",
				`const found = require(${JSON.stringify(require.resolve("./line-scan.js"))})[process.argv[1]](require("node:fs").readFileSync(0, "utf8")); process.exit(found.length === 0 ? 0 : 1)`,
				name,
			],
			{ input: text, timeout: PARSER_TIMEOUT_MS },
		);
		expect(r.signal).toBeNull();
		expect(r.status).toBe(0);
	});
});
