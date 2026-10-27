// @vitest-environment node
/*
 * lib/suite-bounded.js, in process: the test files a run-vitest.js launch is
 * bounded to, and the vitest workers a running runner line can occupy (#1186,
 * #2558, #2560).
 *
 * Misread a bound and the suite gate charges a whole suite at a part-suite's
 * rung, letting it past the count cap into the 10 GB cap, or refuses a
 * one-file run as if it were the whole suite.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WHOLE_SLOT_BOUND } from "./whole-slot-bound";

interface Weight {
	resolvedFiles: number | null;
	wholeSlot: boolean;
}

const {
	SUITE_VALUED_FLAGS,
	WHOLE_SUITE_WORKERS,
	resolvedFileCount,
	runnerTestFileCount,
	vitestLineWeigh,
	weighFiles,
} = require("./suite-bounded.js") as {
	SUITE_VALUED_FLAGS: Set<string>;
	WHOLE_SUITE_WORKERS: number;
	resolvedFileCount: (
		argv: string[],
		readSuite: () => string[] | null,
	) => number | null;
	runnerTestFileCount: (argv: string[]) => number | null;
	vitestLineWeigh: (
		line: string,
		carried?: Weight | null,
	) => { workers: number; part: boolean };
	weighFiles: (files: number | null) => { workers: number; part: boolean };
};

const COUNTS: [string, number | null][] = [
	["", null],
	["scripts/foo.test.ts", 1],
	["a.test.ts b.spec.tsx c.test.js d.test.mts", 4],
	["-t foo scripts/foo.spec.tsx", 1],
	["--retest a.test.ts", 1],
	["--changed HEAD a.test.ts", 1],
	["--full=coverage a.test.ts", 1],
	["--queue a.test.ts", 1],
	["-t foo", null],
	/* A flag where a value would stand is no value: its own value follows. */
	["-t --project x.test.ts", null],
	["--changed", null],
	["--changed a.test.ts", null],
	["--changed=HEAD a.test.ts", 1],
	["scripts/lib/", null],
	["--adopt x.js", null],
	["--adopt a.test.ts", null],
	["a.test.ts --adopt x.js", null],
	/* A bare word vitest reads as a path filter (#2559). */
	["run new-repo.test.ts", null],
	["-t a.test.ts", null],
];

const runner = (tail: string) => `node /r/node_modules/.bin/vitest${tail}`;
const namedFiles = (n: number) =>
	Array.from({ length: n }, (_, i) => `f${i}.test.ts`).join(" ");
const W = WHOLE_SUITE_WORKERS;
const WEIGHS: [string, number, boolean][] = [
	[runner(" run"), W, false],
	[runner(" run --passWithNoTests a.test.ts"), 1, true],
	[runner(" run a.test.ts b.spec.tsx"), 2, true],
	[runner(" run a.test.ts b.test.ts c.test.ts"), 3, true],
	[runner(" run a.test.ts b.test.ts c.test.ts d.test.ts"), 4, true],
	[runner(` run ${namedFiles(WHOLE_SLOT_BOUND - 1)}`), W, true],
	[runner(` run ${namedFiles(WHOLE_SLOT_BOUND)}`), W, false],
	[runner(" run run a.test.ts"), W, false],
	[runner(" run -t foo a.test.ts"), 1, true],
	/* A `watch` word makes a watcher wherever it stands, a flag's value too. */
	[runner(" run -t watch a.test.ts"), W, false],
	[runner(" run --testNamePattern=foo a.test.ts"), 1, true],
	[runner(" run --unknownFlag x a.test.ts"), W, false],
	[runner(" run scripts/lib/"), W, false],
	[runner(" --silent --run a.test.ts"), 1, true],
	[runner(" run --watch a.test.ts"), W, false],
	[runner(" a.test.ts"), W, false],
	[runner(""), W, false],
	["node_modules/.bin/vitest run a.test.ts", 1, true],
	...[...SUITE_VALUED_FLAGS].map((flag): [string, number, boolean] => [
		runner(` run ${flag} x a.test.ts`),
		1,
		true,
	]),
];

describe("runnerTestFileCount, the files a launch is bounded to", () => {
	it.each(COUNTS)(
		"reads `%s` as bounded to %s test file(s), null being unbounded",
		(argv, files) => {
			expect(runnerTestFileCount(argv ? argv.split(" ") : [])).toBe(files);
		},
	);
});

describe("vitestLineWeigh, the workers a running run can occupy (#2560)", () => {
	it.each(WEIGHS)("weighs `%s` at %i worker(s), part %s", (line, w, part) => {
		expect(vitestLineWeigh(line)).toEqual({ workers: w, part });
	});
});

describe("the carried weight, over the runner line (#2931)", () => {
	it.each([
		[{ resolvedFiles: 40, wholeSlot: false }, 5, true],
		[{ resolvedFiles: 2, wholeSlot: false }, 2, true],
		[{ resolvedFiles: 485, wholeSlot: true }, W, false],
		[{ resolvedFiles: null, wholeSlot: true }, W, false],
	])(
		"weighs a run carrying %j at %i worker(s), part %s",
		(carried, w, part) => {
			expect(vitestLineWeigh(runner(" run"), carried)).toEqual({
				workers: w,
				part,
			});
		},
	);

	it("still weighs a watcher whole", () => {
		expect(
			vitestLineWeigh(runner(""), { resolvedFiles: 2, wholeSlot: false }),
		).toEqual({ workers: W, part: false });
	});
});

describe("weighFiles, the whole-slot bound (#2931)", () => {
	it.each([
		[0, 0, true],
		[3, 3, true],
		[WHOLE_SLOT_BOUND - 1, W, true],
		[WHOLE_SLOT_BOUND, W, false],
		[null, W, false],
	])("weighs %s resolved file(s) at %i worker(s), part %s", (n, w, part) => {
		expect(weighFiles(n)).toEqual({ workers: w, part });
	});
});

describe("resolvedFileCount, the files a launch runs in its own suite (#2931)", () => {
	const suite = Array.from({ length: 50 }, (_, i) =>
		i < 10 ? `scripts/lib/t${i}.test.ts` : `scripts/t${i}.test.ts`,
	);
	it.each([
		["", 50],
		["--full=coverage", 50],
		["-t foo", 50],
		["a.test.ts b.test.ts", 2],
		["scripts/lib/", 10],
		["--retest", 50],
	])("resolves `%s` to %i of a 50-file suite", (argv, n) => {
		expect(resolvedFileCount(argv ? argv.split(" ") : [], () => suite)).toBe(n);
	});

	it.each([["--changed"], ["--changed=HEAD a.test.ts"], ["--adopt x.js"]])(
		"leaves an unexpanded `%s` unresolved",
		(argv) => {
			expect(resolvedFileCount(argv.split(" "), () => suite)).toBeNull();
		},
	);

	it("leaves a run in an unread suite unresolved, unless it names its files", () => {
		expect(resolvedFileCount([], () => null)).toBeNull();
		expect(resolvedFileCount(["a.test.ts"], () => null)).toBe(1);
	});
});

describe("the whole-suite charge", () => {
	it("charges a whole suite at the maxWorkers vitest.config.ts pins", () => {
		const config = fs.readFileSync(
			path.resolve(__dirname, "..", "..", "vitest.config.ts"),
			"utf8",
		);
		expect(WHOLE_SUITE_WORKERS).toBe(
			Number(/maxWorkers: (\d+)/.exec(config)?.[1]),
		);
	});
});
