// @vitest-environment node
/*
 * Pins precommit-exit.js's reading of a pre-commit hook's text, in-process
 * (#4123). check-precommit-exit.test.ts holds the program's boundary cases.
 * Built on hook text alone, so each shape needs no hook file on disk.
 * Breaking it lets a hook line turn a checker's BROKEN into a finding to
 * fix (base §N4).
 */

import { describe, expect, it } from "vitest";
import { judgeHook, parseBreaches } from "./precommit-exit.js";

const lines = (...text: string[]) =>
	parseBreaches(text.join("\n")).map((b) => b.line);

describe("parseBreaches", () => {
	it("names a checker line exiting 1, by interpreter or a script run directly", () => {
		expect(
			lines(
				"node scripts/check-a.js || exit 1",
				"bash scripts/b.sh --x || exit 1",
				"./scripts/c.sh || exit 1",
			),
		).toEqual([1, 2, 3]);
	});

	it("passes a checker passing its code on, and an outside command or inline code exiting 1", () => {
		expect(
			lines(
				'node scripts/check-a.js || exit "$?"',
				"gitleaks protect --staged || exit 1",
				'node -e "process.exit(1)" || exit 1',
				'sh -c "$declared_command" || exit 1',
			),
		).toEqual([]);
	});

	it("names a block exiting 1 before its close, and passes one exiting its own code", () => {
		expect(
			lines(
				"node scripts/a.js || {",
				'\techo "failed"',
				"\texit 1",
				"}",
				"node scripts/b.js || {",
				'\trc=$?; exit "$rc"',
				"}",
			),
		).toEqual([1]);
	});

	it("names a fallback whose case exits 1 from its catch-all arm, and passes one reassigned first", () => {
		expect(
			lines(
				'out="$(node scripts/a.js)" || rc=$?',
				'case "$rc" in',
				"2) exit 2 ;;",
				"*) exit 1 ;;",
				"esac",
			),
		).toEqual([1]);
		expect(
			lines(
				'out="$(node scripts/a.js)" || rc=$?',
				"rc=0",
				'case "$rc" in',
				"*) exit 1 ;;",
				"esac",
			),
		).toEqual([]);
	});

	it("numbers a continued line by its first line, its text collapsed, and skips a comment", () => {
		expect(
			parseBreaches(
				"# node scripts/a.js || exit 1\nnode scripts/a.js \\\n\t--x || exit 1\n",
			),
		).toEqual([{ line: 2, text: "node scripts/a.js --x || exit 1" }]);
	});

	it("reads a substitution holding a pipeline as no checker", () => {
		expect(lines('out="$(node scripts/a.js | head -1)" || exit 1')).toEqual([]);
	});

	it.each([
		["a bash script", 'bash "$WFC_PLUGIN_ROOT"/scripts/gate.sh || exit 1', 1],
		["an sh script", "sh scripts/gate.sh || exit 1", 1],
		["a script run directly", "./scripts/check-b.js || exit 1", 1],
		[
			"node past its flags",
			"node --no-warnings scripts/check-b.js || exit 1",
			1,
		],
		[
			"an indented line in an if",
			"if armed x; then\n  node scripts/c.js || exit 1\nfi",
			2,
		],
		["a trailing comment", "node scripts/c.js || exit 1 # why", 1],
		["a case arm's terminator", "node scripts/c.js || exit 1 ;; # why", 1],
		["a variable assignment", "X=1 node scripts/c.js || exit 1", 1],
		["a bash script run under errexit", "bash -e scripts/gate.sh || exit 1", 1],
	])("names %s exiting 1", (_, body, line) => {
		expect(lines(`${body}\n`)).toEqual([line]);
	});

	it("names a block whose exit 1 carries a semicolon and a comment", () => {
		expect(lines("node scripts/c.js || {\n  exit 1 ; # why\n}\n")).toEqual([1]);
	});

	it("passes a block exiting 1 only after its close", () => {
		expect(lines("node scripts/d.js || {\n  echo x\n}\nexit 1\n")).toEqual([]);
	});

	it.each([
		[
			"a binary",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
			'"${WFC_GITLEAKS:-gitleaks}" git --staged --redact || exit 1',
		],
		["a declared command", 'sh -c "$declared_command" || exit 1'],
		["inline node", "node -e 'process.exit(0)' || exit 1"],
	])("passes %s, an outside command", (_, line) => {
		expect(lines(`${line}\n`)).toEqual([]);
	});

	// A named arm is the checker's own answer, and a probe of an outside command
	// runs no checker (#3808).
	it.each([
		[
			"a named arm exiting 1 and a catch-all exiting 2",
			'p="$(node scripts/probe.js)" || p=""\ncase "$p" in\n  bad) exit 1 ;;\n  *) exit 2 ;;\nesac\n',
		],
		[
			"a catch-all exiting 2 ahead of an exit 1 past its commented terminator",
			'p="$(node scripts/probe.js)" || p=""\ncase "$p" in\n  *)\n    exit 2\n    ;; # why\n  bad) exit 1 ;;\nesac\n',
		],
		[
			"a nested case's catch-all exiting 1 beside an outer one exiting 2",
			'p="$(node scripts/probe.js)" || p=""\ncase "$p" in\n  a)\n    case "$q" in\n      *) exit 1 ;;\n    esac\n    ;;\n  *) exit 2 ;;\nesac\n',
		],
		[
			"a nested esac ending its arm ahead of an exit 1 in the next",
			'p="$(node scripts/probe.js)" || p=""\ncase "$p" in\n  *)\n    case "$q" in\n      a) exit 2 ;;\n    esac ;;\n  bad) exit 1 ;;\nesac\n',
		],
		[
			"an outside command's substitution",
			'p="$(git rev-parse HEAD)" || p=""\ncase "$p" in\n  *) exit 1 ;;\nesac\n',
		],
		[
			"a pipeline's substitution, its last command's status deciding",
			'p="$(node scripts/probe.js | head -1)" || exit 1\n',
		],
		["a probe no case reads", 'p="$(node scripts/probe.js)" || p=""\nexit 1\n'],
		[
			"a catch-all exiting 1 on another variable's case",
			'p="$(node scripts/probe.js)" || p=""\ncase "$q" in\n  *) exit 1 ;;\nesac\n',
		],
		[
			"a fallback assigned again before its case",
			'a="$(node scripts/a.js)" || rc=$?\nrc=0\nb="$(git x)" || rc=$?\ncase "$rc" in\n  *) exit 1 ;;\nesac\n',
		],
	])("passes %s", (_, body) => {
		expect(lines(body)).toEqual([]);
	});
});

describe("judgeHook", () => {
	it("names the hook file, line and line text in the message it prints", () => {
		expect(
			judgeHook(".husky/pre-commit", "node scripts/a.js || exit 1\n"),
		).toEqual([
			{
				line: 1,
				match: "node scripts/a.js || exit 1",
				message: expect.stringMatching(
					/^\.husky\/pre-commit:1 exits 1 on a checker's failure, turning its BROKEN into a finding \(`node scripts\/a\.js \|\| exit 1`\)\. Fix: pass the checker's own exit code on/,
				),
			},
		]);
	});

	it("names a lister's block exiting 1 on its substitution at its opening line, its fix saying a crash exits 2 (#3808)", () => {
		const found = judgeHook(
			".husky/pre-commit",
			'x="$(node scripts/list.js --sources)" || {\n  echo "refused" >&2\n  exit 1\n}\n',
		);
		expect(found.map((f) => f.line)).toEqual([1]);
		expect(found[0]?.message).toContain("its crash exits 2");
	});

	it.each([
		[
			"its own variable, on the arm's second line",
			'p="$(node scripts/probe.js)" || p=""\ncase "$p" in\n  ok:*) ;;\n  *)\n    echo "crashed" >&2\n    exit 1\n    ;;\nesac\n',
			1,
		],
		[
			"another variable, on the arm's own line",
			'rc=0\np="$(node scripts/probe.js)" || rc=$?\n# why\ncase "$rc" in\n  0) ;;\n  *) exit 1 ;;\nesac\n',
			2,
		],
		[
			"an arm following a nested case's own catch-all",
			'p="$(node scripts/probe.js)" || p=""\ncase "$p" in\n  a)\n    case "$q" in\n      *) exit 2 ;;\n    esac\n    ;;\n  *) exit 1 ;;\nesac\n',
			1,
		],
	])(
		"names a probe whose catch-all arm exits 1, through %s, its fix saying a crash exits 2 (#3808)",
		(_, body, line) => {
			const found = judgeHook(".husky/pre-commit", body);
			expect(found.map((f) => f.line)).toEqual([line]);
			expect(found[0]?.message).toContain("its crash exits 2");
		},
	);
});
