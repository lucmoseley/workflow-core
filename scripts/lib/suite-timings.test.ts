// @vitest-environment node
/*
 * The seam's own suite: rowsFrom, shares and the CSV round trip in isolation
 * (mantahostels#2039).
 * In-process with injected values and asserted return values, which is what a
 * `lib/**` test is for — the CLI's end-to-end behaviour is
 * scripts/suite-timings.test.ts's, not this file's.
 *
 * WHAT BREAKING THESE COSTS. Every figure in
 * the suite-file-timings note (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/suite-file-timings.md)'s appended correction was produced by
 * `shares`, and docs/agents/guard-registry.md §Conventions rests a live rule on that table. A
 * silently wrong share here is a wrong rule with nothing to catch it: the
 * dataset is a dated record, so the number is quoted long after the run that
 * made it.
 */

import { describe, expect, it } from "vitest";
import {
	formatShares,
	parseCsv,
	parseMeta,
	reportRoot,
	rowsFrom,
	shares,
	toCsv,
} from "./suite-timings";

const ROOT = "/repo";

/** One vitest-shaped file result, its start and end given in milliseconds. */
const fileResult = (name: string, start: number, end: number, tests = 1) => ({
	name: `${ROOT}/${name}`,
	startTime: start,
	endTime: end,
	status: "passed",
	assertionResults: Array.from({ length: tests }, () => ({})),
});

describe("reportRoot (#2413)", () => {
	const named = (...names: string[]) => ({
		testResults: names.map((name) => ({ name })),
	});
	const here = new Set(["eslint.config.test.ts", "scripts/x.test.ts"]);
	const exists = (f: string) => here.has(f);
	const runner = "/home/runner/work/wc/wc/.claude/worktrees/isolated-1";

	it("keeps this checkout's root where every name is inside it", () => {
		expect(reportRoot(named(`${ROOT}/a.test.ts`), ROOT, exists)).toBe(ROOT);
	});

	it("takes another checkout's root from its names, as a runner's report has", () => {
		expect(
			reportRoot(
				named(`${runner}/eslint.config.test.ts`, `${runner}/scripts/x.test.ts`),
				ROOT,
				exists,
			),
		).toBe(runner);
	});

	it("keeps a shared subdirectory in the names, where every file sits in one", () => {
		expect(reportRoot(named(`${runner}/scripts/x.test.ts`), ROOT, exists)).toBe(
			runner,
		);
	});
});

describe("reading a vitest JSON report", () => {
	it("gives each file its duration in seconds, relative to the repo root, heaviest first", () => {
		const rows = rowsFrom(
			{
				testResults: [
					fileResult("a.test.ts", 0, 1000),
					fileResult("b.test.ts", 0, 4000),
				],
			},
			ROOT,
		);
		expect(rows).toEqual([
			{ file: "b.test.ts", seconds: 4, tests: 1, status: "passed" },
			{ file: "a.test.ts", seconds: 1, tests: 1, status: "passed" },
		]);
	});

	it("keeps a file missing its timestamps, with a null duration rather than a zero (mantahostels#2039)", () => {
		expect(
			rowsFrom(
				{
					testResults: [
						{
							name: `${ROOT}/x.test.ts`,
							status: "failed",
							assertionResults: [],
						},
					],
				},
				ROOT,
			),
		).toEqual([
			{ file: "x.test.ts", seconds: null, tests: 0, status: "failed" },
		]);
	});

	it("returns no rows rather than throwing when the report carries no results", () => {
		expect(rowsFrom({}, ROOT)).toEqual([]);
	});
});

describe("computing the percentile shares", () => {
	it("gives each slice its cumulative share of file-seconds", () => {
		expect(
			shares(
				[{ seconds: 50 }, { seconds: 30 }, { seconds: 10 }, { seconds: 10 }],
				[1, 2],
			).slices,
		).toEqual([
			{ top: 1, sharePct: 50 },
			{ top: 2, sharePct: 80 },
		]);
	});

	it("takes the median of an even count as the mean of the middle two", () => {
		expect(shares([{ seconds: 1 }, { seconds: 3 }]).medianSeconds).toBe(2);
	});

	it("leaves an untimed file out of the total and counts it separately (mantahostels#2039)", () => {
		const s = shares([{ seconds: 10 }, { seconds: null }], [1]);
		expect(s.totalSeconds).toBe(10);
		expect(s.timedFiles).toBe(1);
		expect(s.untimedFiles).toBe(1);
		expect(s.slices).toEqual([{ top: 1, sharePct: 100 }]);
	});

	it("counts every file when all of them are timed, so the untimed count is a real signal", () => {
		const s = shares([{ seconds: 10 }, { seconds: 5 }], [1]);
		expect(s.untimedFiles).toBe(0);
		expect(s.totalSeconds).toBe(15);
	});

	it("drops a slice wider than the dataset rather than reporting a short one as complete", () => {
		expect(shares([{ seconds: 1 }], [1, 5]).slices).toEqual([
			{ top: 1, sharePct: 100 },
		]);
	});

	it("names each slice and the median in the text a reader compares against the note", () => {
		const text = formatShares(shares([{ seconds: 3 }, { seconds: 1 }], [1]));
		expect(text).toContain("file-seconds: 4");
		expect(text).toContain("median file: 2 s");
		expect(text).toContain("top 1: 75%");
	});
});

describe("the CSV round trip", () => {
	it("returns the rows it was given, an untimed row included", () => {
		const rows = [
			{ file: "a.test.ts", seconds: 4.2, tests: 3, status: "passed" },
			{ file: "b.test.ts", seconds: null, tests: 0, status: "failed" },
		];
		const back = parseCsv(toCsv(rows, { sha: "abc", run: "2026-08-30" }));
		expect(back.rows).toEqual(rows);
		expect(back.meta).toEqual({ sha: "abc", run: "2026-08-30" });
	});

	it("tells an untimed cell from a genuine zero on the way back (mantahostels#2039)", () => {
		const rows = [
			{ file: "a.test.ts", seconds: 0, tests: 1, status: "passed" },
			{ file: "b.test.ts", seconds: null, tests: 1, status: "passed" },
		];
		expect(parseCsv(toCsv(rows, {})).rows).toEqual(rows);
	});

	it("writes the metadata above the header, so a reader meets the run's conditions first", () => {
		expect(toCsv([], { sha: "abc" }).split("\n").slice(0, 2)).toEqual([
			"# sha: abc",
			"file,seconds,tests,status",
		]);
	});
});

describe("reading key=value metadata", () => {
	it("collects every pair, keeping an `=` inside the value", () => {
		expect(parseMeta(["sha=abc", "command=a --out=b"]).meta).toEqual({
			sha: "abc",
			command: "a --out=b",
		});
	});

	it("names the first argument that is not a pair rather than skipping it", () => {
		expect(parseMeta(["sha=abc", "nope"]).bad).toBe("nope");
	});
});
