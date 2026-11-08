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

	it("reads a substitution holding a pipeline as no checker", () => {
		expect(lines('out="$(node scripts/a.js | head -1)" || exit 1')).toEqual([]);
	});
});
