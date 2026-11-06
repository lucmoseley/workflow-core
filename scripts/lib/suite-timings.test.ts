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

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	formatShares,
	parseCsv,
	parseMeta,
	reportRoot,
	rowsFrom,
	SETTLE_MS,
	shares,
	timingSources,
	toCsv,
} from "./suite-timings";

const ROOT = "/repo";

/** One file result as scripts/vitest-json-reporter.ts writes it, in ms. */
const fileResult = (name: string, duration: number, tests = 1) => ({
	name: `${ROOT}/${name}`,
	startTime: 0,
	endTime: 0,
	duration,
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

	it("takes this checkout's root where its names name files here", () => {
		expect(reportRoot(named(`${ROOT}/scripts/x.test.ts`), ROOT, exists)).toBe(
			ROOT,
		);
	});

	it("falls back to this checkout's root where no name is a file here", () => {
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

	it("takes an isolated worktree under this checkout as the root its names sit under (#4352)", () => {
		const isolated = `${ROOT}/.claude/worktrees/isolated-2673`;
		const report = named(
			`${isolated}/eslint.config.test.ts`,
			`${isolated}/scripts/x.test.ts`,
		);
		const root = reportRoot(report, ROOT, exists);
		expect(root).toBe(isolated);
		expect(rowsFrom(report, root).map((r) => r.file)).toEqual([
			"eslint.config.test.ts",
			"scripts/x.test.ts",
		]);
	});

	it("takes the isolated worktree over this checkout while that worktree still exists (#4352)", () => {
		const isolated = `${ROOT}/.claude/worktrees/isolated-1`;
		const prefix = `${path.relative(ROOT, isolated)}/`;
		const existsInEither = (f: string) =>
			exists(f) || (f.startsWith(prefix) && exists(f.slice(prefix.length)));
		expect(
			reportRoot(named(`${isolated}/scripts/x.test.ts`), ROOT, existsInEither),
		).toBe(isolated);
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
					fileResult("a.test.ts", 1000),
					fileResult("b.test.ts", 4000),
				],
			},
			ROOT,
		);
		expect(rows).toEqual([
			{ file: "b.test.ts", seconds: 4, tests: 1, status: "passed" },
			{ file: "a.test.ts", seconds: 1, tests: 1, status: "passed" },
		]);
	});

	it("times a file by its duration, hooks included, not by its tests' endTime - startTime (#4313)", () => {
		const hooked = { ...fileResult("h.test.ts", 82_100), endTime: 63_100 };
		expect(rowsFrom({ testResults: [hooked] }, ROOT)[0]?.seconds).toBe(82.1);
	});

	it("keeps a file missing its duration, with a null one rather than a zero (mantahostels#2039)", () => {
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

describe("choosing the run a sharded run plans by (#4574)", () => {
	const Before = Date.parse("2026-11-06T10:00:00Z");
	const at = (msBefore: number) => new Date(Before - msBefore).toISOString();
	const listed = (
		id: number,
		createdMsBefore: number,
		doneMsBefore: number,
		over: Partial<{ status: string; conclusion: string | null }> = {},
	) => ({
		id,
		status: "completed",
		conclusion: "success",
		created_at: at(createdMsBefore),
		updated_at: at(doneMsBefore),
		...over,
	});

	it("takes green runs finished before the planning run, newest first", () => {
		const runs = [
			listed(1, 900_000, 700_000),
			listed(3, 500_000, 300_000),
			listed(2, 600_000, 400_000),
		];
		expect(timingSources(runs, Before)).toEqual([3, 2, 1]);
	});

	it("passes over a run that finished inside the settle window, or after the planning run began", () => {
		const runs = [
			listed(1, 900_000, 700_000),
			listed(2, 300_000, SETTLE_MS - 1),
			listed(3, 200_000, -60_000),
		];
		expect(timingSources(runs, Before)).toEqual([1]);
	});

	it("passes over a run not green or not finished", () => {
		const runs = [
			listed(1, 900_000, 700_000),
			listed(2, 800_000, 600_000, { conclusion: "failure" }),
			listed(3, 800_000, 600_000, { status: "in_progress", conclusion: null }),
		];
		expect(timingSources(runs, Before)).toEqual([1]);
	});

	it("answers the same whatever order the runs are listed in", () => {
		const runs = [listed(1, 900_000, 700_000), listed(2, 600_000, 400_000)];
		expect(timingSources([...runs].reverse(), Before)).toEqual(
			timingSources(runs, Before),
		);
	});
});
