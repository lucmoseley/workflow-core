// @vitest-environment node
/*
 * The sums behind .github/workflows/scheduled-checks.yml. Every fixture here is a job shape the
 * runs API really returns.
 *
 * Settled at mantahostels#386 (the reproducible census) and #405 (GitHub
 * Free's 2,000-minute allowance). It runs in-process on hand-built API shapes,
 * with no network: measure-ci-billing.js does the fetching, so the sums are
 * checked against known answers.
 *
 * No hook or CI step refuses on it — measure-ci-billing.js is run by hand —
 * so a loosened case lets a wrong bill through silently: CI cost misread
 * against the free allowance, or a missed trigger read as clean.
 */

import { describe, expect, it } from "vitest";

const {
	summarise,
	monthlyProjection,
	clampUntil,
	windowSpanDays,
	dayWindows,
	filterRuns,
	foldShareRows,
	parseCommitLog,
	foldPushes,
	pushCommitStats,
	dailySeries,
	dailyMeanBand,
} = require("./ci-billing.js");

/** A finished job of `seconds` seconds, starting at a fixed instant. */
const job = (seconds: number, conclusion = "success") => ({
	conclusion,
	started_at: "2026-08-14T10:00:00Z",
	completed_at: new Date(
		Date.parse("2026-08-14T10:00:00Z") + seconds * 1000,
	).toISOString(),
});

/** A job GitHub has started and not finished — completed_at is null. */
const inFlight = {
	conclusion: null,
	started_at: "2026-08-14T10:00:00Z",
	completed_at: null,
};

const run = (over: Record<string, unknown> = {}) => ({
	id: 1,
	event: "push",
	head_sha: "aaa",
	created_at: "2026-08-14T10:00:00Z",
	...over,
});

/** summarise over one push run carrying `jobs`. */
const oneRun = (jobs: unknown[], over: Record<string, unknown> = {}) =>
	summarise([run(over)], () => jobs);

describe("a job's own minutes", () => {
	it("measures the job's own start-to-finish", () => {
		expect(oneRun([job(107)]).actual).toBeCloseTo(107 / 60);
	});

	it("counts a job still in flight as unfinished — not as zero minutes", () => {
		const s = oneRun([inFlight]);
		expect(s.unfinished).toBe(1);
		expect(s.billed).toBe(0);
	});

	it("counts a missing or unparseable timestamp as unfinished", () => {
		expect(
			oneRun([
				{ started_at: null, completed_at: "x" },
				{ started_at: "not-a-date", completed_at: "also-not" },
			]).unfinished,
		).toBe(2);
	});

	it("rejects a job that finished before it started as bad data", () => {
		expect(
			oneRun([
				{
					started_at: "2026-08-14T10:01:00Z",
					completed_at: "2026-08-14T10:00:00Z",
				},
			]).unfinished,
		).toBe(1);
	});
});

describe("billed minutes — per job, rounded UP", () => {
	it("rounds a part-minute up to the whole minute", () => {
		expect(oneRun([job(1)]).billed).toBe(1);
		expect(oneRun([job(59)]).billed).toBe(1);
		expect(oneRun([job(61)]).billed).toBe(2);
		expect(oneRun([job(107)]).billed).toBe(2);
	});

	it("bills nothing for a job the if: guard skipped", () => {
		expect(oneRun([job(300, "skipped")]).billed).toBe(0);
	});

	it("bills a failed job", () => {
		expect(oneRun([job(90, "failure")]).billed).toBe(2);
	});

	it("bills a cancelled job for the time it ran", () => {
		expect(oneRun([job(90, "cancelled")]).billed).toBe(2);
	});
});

describe("summarise", () => {
	const jobsOf = (map: Record<number, unknown[]>) => (r: { id: number }) =>
		map[r.id] || [];

	it("totals jobs, actual and billed, and reports the round-up ratio", () => {
		const runs = [run({ id: 1 }), run({ id: 2, head_sha: "bbb" })];
		const s = summarise(runs, jobsOf({ 1: [job(61), job(61)], 2: [job(61)] }));
		expect(s.runs).toBe(2);
		expect(s.jobs).toBe(3);
		expect(s.actual).toBeCloseTo(3.05, 5);
		expect(s.billed).toBe(6);
		expect(s.ratio).toBeCloseTo(6 / 3.05, 5);
	});

	it("counts an unfinished job without billing it, and says how many", () => {
		const s = summarise([run()], jobsOf({ 1: [job(61), inFlight] }));
		expect(s.jobs).toBe(2);
		expect(s.unfinished).toBe(1);
		expect(s.billed).toBe(2);
		expect(s.actual).toBeCloseTo(61 / 60, 5);
	});

	it("counts a skipped job without billing it, and says how many", () => {
		const s = summarise([run()], jobsOf({ 1: [job(61), job(9, "skipped")] }));
		expect(s.jobs).toBe(2);
		expect(s.skipped).toBe(1);
		expect(s.billed).toBe(2);
	});

	it("collapses the several runs one push fires to a single push", () => {
		const runs = [
			run({ id: 1, head_sha: "aaa" }),
			run({ id: 2, head_sha: "aaa" }),
			run({ id: 3, head_sha: "bbb" }),
		];
		const s = summarise(
			runs,
			jobsOf({ 1: [job(30)], 2: [job(30)], 3: [job(30)] }),
		);
		expect(s.pushes).toBe(2);
		expect(s.billedPerPush).toBeCloseTo(1.5, 5);
	});

	it("counts only push-triggered runs as pushes", () => {
		const runs = [
			run({ id: 1, event: "push", head_sha: "aaa" }),
			run({ id: 2, event: "schedule", head_sha: "sss" }),
			run({ id: 3, event: "workflow_dispatch", head_sha: "ddd" }),
		];
		const s = summarise(
			runs,
			jobsOf({ 1: [job(30)], 2: [job(30)], 3: [job(30)] }),
		);
		expect(s.pushes).toBe(1);
		expect(s.billed).toBe(3);
	});

	it("buckets by UTC day, sorted, with each day's own push count", () => {
		const runs = [
			run({ id: 1, created_at: "2026-08-15T23:00:00Z", head_sha: "aaa" }),
			run({ id: 2, created_at: "2026-08-14T01:00:00Z", head_sha: "bbb" }),
			run({ id: 3, created_at: "2026-08-14T02:00:00Z", head_sha: "bbb" }),
		];
		const s = summarise(
			runs,
			jobsOf({ 1: [job(30)], 2: [job(30)], 3: [job(30)] }),
		);
		expect(s.perDay.map((d: { day: string }) => d.day)).toEqual([
			"2026-08-14",
			"2026-08-15",
		]);
		expect(s.perDay[0]).toMatchObject({
			runs: 2,
			jobs: 2,
			billed: 2,
			pushes: 1,
		});
		expect(s.perDay[1]).toMatchObject({
			runs: 1,
			jobs: 1,
			billed: 1,
			pushes: 1,
		});
	});

	it("survives an empty window without dividing by zero", () => {
		const s = summarise([], () => []);
		expect(s).toMatchObject({
			runs: 0,
			jobs: 0,
			billed: 0,
			ratio: 0,
			pushes: 0,
		});
		expect(s.billedPerPush).toBe(0);
	});
});

describe("monthlyProjection", () => {
	it("defaults to GitHub Free's 2,000 minutes", () => {
		expect(monthlyProjection({ billed: 10, pushes: 1 }, 1).allowance).toBe(
			2000,
		);
	});

	it("reports negative headroom once the projection passes the allowance", () => {
		const p = monthlyProjection({ billed: 834, pushes: 186 }, 5, 3000);
		expect(p.perMonth).toBeCloseTo(5004, 5);
		expect(p.usedPct).toBeCloseTo(166.8, 1);
		expect(p.headroomPct).toBeLessThan(0);
	});

	it("prices against an allowance other than the default", () => {
		const p = monthlyProjection({ billed: 100, pushes: 10 }, 2, 1500);
		expect(p.allowance).toBe(1500);
		expect(p.usedPct).toBe(100);
	});

	it("scales a part-window to a 30-day month and prices the allowance", () => {
		const p = monthlyProjection({ billed: 100, pushes: 20 }, 2, 3000);
		expect(p.perMonth).toBe(1500);
		expect(p.pushesPerDay).toBe(10);
		expect(p.usedPct).toBe(50);
		expect(p.headroomPct).toBe(50);
	});

	it("refuses a zero-length window rather than returning Infinity", () => {
		expect(monthlyProjection({ billed: 100, pushes: 20 }, 0)).toBeNull();
	});
});

describe("the day a run is bucketed on", () => {
	const days = (createdAt: unknown) =>
		oneRun([], { created_at: createdAt }).perDay.map(
			(d: { day: string }) => d.day,
		);

	it("buckets on UTC, not the machine's UTC+8", () => {
		expect(days("2026-08-14T23:30:00Z")).toEqual(["2026-08-14"]);
	});

	it("files a run under no day where GitHub gave no readable timestamp", () => {
		expect(days(null)).toEqual([]);
		expect(days("not a date")).toEqual([]);
	});
});

describe("filterRuns", () => {
	const runs = [
		run({ id: 1, event: "push" }),
		run({ id: 2, event: "pull_request" }),
		run({ id: 3, event: "schedule" }),
	];

	it("drops the events named and keeps everything else", () => {
		const kept = filterRuns(runs, ["pull_request"]);
		expect(kept.map((r: { id: number }) => r.id)).toEqual([1, 3]);
	});

	it("keeps every run when nothing is excluded", () => {
		expect(filterRuns(runs, []).length).toBe(3);
		expect(filterRuns(runs).length).toBe(3);
	});
});

describe("summarise — per-workflow billed split", () => {
	const jobsOf = (map: Record<number, unknown[]>) => (r: { id: number }) =>
		map[r.id] || [];

	it("splits billed minutes by workflow and gives each its share", () => {
		const runs = [
			run({ id: 1, name: "Lint and tests" }),
			run({ id: 2, name: "Python", head_sha: "bbb" }),
			run({ id: 3, name: "Lint and tests", head_sha: "ccc" }),
		];
		const s = summarise(
			runs,
			jobsOf({ 1: [job(120)], 2: [job(60)], 3: [job(120)] }),
		);
		expect(s.perWorkflow).toEqual([
			{ workflow: "Lint and tests", runs: 2, jobs: 2, billed: 4, pct: 80 },
			{ workflow: "Python", runs: 1, jobs: 1, billed: 1, pct: 20 },
		]);
	});

	it("names an unnamed workflow rather than dropping its minutes", () => {
		const s = summarise(
			[run({ id: 1, name: undefined })],
			jobsOf({ 1: [job(60)] }),
		);
		expect(s.perWorkflow[0].workflow).toBe("(unnamed)");
		expect(s.perWorkflow[0].billed).toBe(1);
	});

	it("gives a zero-billed window shares of zero, not NaN", () => {
		const s = summarise([run({ id: 1, name: "Python" })], jobsOf({ 1: [] }));
		expect(s.perWorkflow[0].pct).toBe(0);
	});
});

describe("foldShareRows", () => {
	const row = (pct: number, billed = pct, jobs = 1) => ({ pct, billed, jobs });

	it("folds the rows under the threshold into one other line", () => {
		const { shown, tail } = foldShareRows(
			[row(80), row(19), row(0.6), row(0.4)],
			1,
		);
		expect(shown.map((r: { pct: number }) => r.pct)).toEqual([80, 19]);
		expect(tail).toEqual({ count: 2, jobs: 2, billed: 1, pct: 1 });
	});

	it("keeps a row sitting exactly on the threshold", () => {
		const { shown, tail } = foldShareRows([row(50), row(1), row(0.9)], 1);
		expect(shown.map((r: { pct: number }) => r.pct)).toEqual([50, 1]);
		expect(tail).toEqual({ count: 1, jobs: 1, billed: 0.9, pct: 0.9 });
	});

	it("reports no tail at all when nothing falls under the threshold", () => {
		const { shown, tail } = foldShareRows([row(60), row(40)], 1);
		expect(shown.length).toBe(2);
		expect(tail).toBeNull();
	});

	// What the event split relies on (mantahostels#677).
	it("folds nothing at a zero threshold, however small the row", () => {
		const { shown, tail } = foldShareRows([row(99.9), row(0.1)], 0);
		expect(shown.map((r: { pct: number }) => r.pct)).toEqual([99.9, 0.1]);
		expect(tail).toBeNull();
	});
});

describe("summarise — per-event billed split", () => {
	const jobsOf = (map: Record<number, unknown[]>) => (r: { id: number }) =>
		map[r.id] || [];

	it("splits billed minutes by trigger event and gives each its share", () => {
		const runs = [
			run({ id: 1, event: "push" }),
			run({ id: 2, event: "pull_request", head_sha: "bbb" }),
			run({ id: 3, event: "push", head_sha: "ccc" }),
		];
		const s = summarise(
			runs,
			jobsOf({ 1: [job(120)], 2: [job(60)], 3: [job(120)] }),
		);
		expect(s.perEvent).toEqual([
			{ event: "push", runs: 2, jobs: 2, billed: 4, pct: 80 },
			{ event: "pull_request", runs: 1, jobs: 1, billed: 1, pct: 20 },
		]);
	});

	it("reports pull_request minutes rather than absorbing them into push", () => {
		const s = summarise(
			[
				run({ id: 1, event: "push" }),
				run({ id: 2, event: "pull_request", head_sha: "bbb" }),
			],
			jobsOf({ 1: [job(60)], 2: [job(180)] }),
		);
		const pr = s.perEvent.find(
			(e: { event: string }) => e.event === "pull_request",
		);
		expect(pr).toMatchObject({ runs: 1, jobs: 1, billed: 3 });
		expect(pr.pct).toBeCloseTo(75, 5);
	});

	it("names an eventless run rather than dropping its minutes", () => {
		const s = summarise(
			[run({ id: 1, event: undefined })],
			jobsOf({ 1: [job(60)] }),
		);
		expect(s.perEvent[0].event).toBe("(unknown)");
		expect(s.perEvent[0].billed).toBe(1);
	});

	it("gives a zero-billed window shares of zero, not NaN", () => {
		const s = summarise([run({ id: 1 })], jobsOf({ 1: [] }));
		expect(s.perEvent[0].pct).toBe(0);
	});
});

describe("summarise — per-job billed split", () => {
	const jobsOf = (map: Record<number, unknown[]>) => (r: { id: number }) =>
		map[r.id] || [];
	const named = (name: string, seconds: number) => ({ ...job(seconds), name });

	it("splits billed minutes by job name across workflows", () => {
		const runs = [
			run({ id: 1, name: "CI" }),
			run({ id: 2, name: "roadmap-digest", head_sha: "bbb" }),
		];
		const s = summarise(
			runs,
			jobsOf({
				1: [named("Lint and tests", 120), named("Python", 60)],
				2: [named("Document guards", 60)],
			}),
		);
		expect(s.perJob).toEqual([
			{
				job: "Lint and tests",
				workflow: "CI",
				jobs: 1,
				billed: 2,
				pct: 50,
			},
			{
				job: "Document guards",
				workflow: "roadmap-digest",
				jobs: 1,
				billed: 1,
				pct: 25,
			},
			{ job: "Python", workflow: "CI", jobs: 1, billed: 1, pct: 25 },
		]);
	});

	it("labels a job name with the first workflow that used it, and still sums both", () => {
		const s = summarise(
			[
				run({ id: 1, name: "CI" }),
				run({ id: 2, name: "other", head_sha: "b" }),
			],
			jobsOf({ 1: [named("Tests", 60)], 2: [named("Tests", 60)] }),
		);
		expect(s.perJob).toEqual([
			{ job: "Tests", workflow: "CI", jobs: 2, billed: 2, pct: 100 },
		]);
	});

	it("gives a zero-billed window job shares of zero, not NaN", () => {
		const s = summarise([run({ id: 1 })], jobsOf({ 1: [] }));
		expect(s.perJob).toEqual([]);
		const z = summarise([run({ id: 1 })], jobsOf({ 1: [job(0)] }));
		expect(z.perJob[0].pct).toBe(0);
	});

	it("names an unnamed job rather than dropping its minutes", () => {
		const s = summarise([run({ id: 1 })], jobsOf({ 1: [job(60)] }));
		expect(s.perJob[0].job).toBe("(unnamed)");
		expect(s.perJob[0].billed).toBe(1);
	});
});

describe("summarise — run attempts", () => {
	const jobsOf = () => [];

	it("counts the runs carrying a second attempt", () => {
		const s = summarise(
			[
				run({ id: 1, run_attempt: 1 }),
				run({ id: 2, run_attempt: 2 }),
				run({ id: 3 }),
			],
			jobsOf,
		);
		expect(s.rerunRuns).toBe(1);
	});
});

describe("parseCommitLog", () => {
	/* `git log --reverse --pretty=format:%x00%H --name-only` output. */
	const log = "\0aaa\n\ndocs/a.md\ndocs/b.md\n\0bbb\n\nscripts/x.js\n\0ccc\n";

	it("reads each commit's sha and the files it touched, oldest first", () => {
		expect(parseCommitLog(log)).toEqual([
			{ sha: "aaa", files: ["docs/a.md", "docs/b.md"] },
			{ sha: "bbb", files: ["scripts/x.js"] },
			/* A merge commit lists no files under --name-only. */
			{ sha: "ccc", files: [] },
		]);
	});

	it("returns nothing for an empty log rather than one blank commit", () => {
		expect(parseCommitLog("")).toEqual([]);
		expect(parseCommitLog("\n")).toEqual([]);
	});
});

describe("a push read as docs-only", () => {
	const docsOnly = (files: string[]) =>
		foldPushes([{ sha: "c1", files }], ["c1"]).pushes[0].docsOnly;

	it("is true when every path is prose or under a docs tree", () => {
		expect(docsOnly(["docs/doc-map.md", "CLAUDE.md", ".claude/x.json"])).toBe(
			true,
		);
	});

	it("is false as soon as one path is code", () => {
		expect(docsOnly(["docs/a.md", "scripts/x.js"])).toBe(false);
	});

	it("is null — not false — when nothing is known to have changed", () => {
		expect(docsOnly([])).toBeNull();
	});
});

describe("foldPushes", () => {
	const commits = [
		{ sha: "c1", files: ["docs/a.md"] },
		{ sha: "c2", files: ["docs/b.md"] },
		{ sha: "c3", files: ["scripts/x.js"] },
		{ sha: "c4", files: ["docs/c.md"] },
	];

	it("gives each push the commits since the previous push head", () => {
		const p = foldPushes(commits, ["c2", "c4"]);
		expect(p.pushes).toEqual([
			{
				sha: "c2",
				commits: 2,
				files: ["docs/a.md", "docs/b.md"],
				docsOnly: true,
			},
			{
				sha: "c4",
				commits: 2,
				files: ["scripts/x.js", "docs/c.md"],
				docsOnly: false,
			},
		]);
	});

	it("counts commits after the last push head as not yet pushed", () => {
		expect(foldPushes(commits, ["c2"]).unpushedCommits).toBe(2);
	});

	it("reports push heads absent from this history rather than silently dropping them", () => {
		const p = foldPushes(commits, ["c2", "zzz"]);
		expect(p.missingHeads).toEqual(["zzz"]);
		expect(p.pushes.length).toBe(1);
	});
});

describe("pushCommitStats", () => {
	it("reports mean, median and the single-commit share", () => {
		const s = pushCommitStats([
			{ commits: 1, docsOnly: true },
			{ commits: 1, docsOnly: false },
			{ commits: 2, docsOnly: false },
			{ commits: 4, docsOnly: false },
		]);
		expect(s.pushes).toBe(4);
		expect(s.commits).toBe(8);
		expect(s.mean).toBe(2);
		expect(s.median).toBe(1.5);
		expect(s.singleCommitShare).toBe(50);
		expect(s.docsOnlyShare).toBe(25);
	});

	it("takes the middle value as the median of an odd count", () => {
		const s = pushCommitStats([{ commits: 5 }, { commits: 1 }, { commits: 2 }]);
		expect(s.median).toBe(2);
	});

	it("leaves an unclassifiable push out of the docs-only denominator", () => {
		const s = pushCommitStats([
			{ commits: 1, docsOnly: true },
			{ commits: 1, docsOnly: null },
		]);
		expect(s.docsOnlyShare).toBe(100);
		expect(s.unclassified).toBe(1);
	});

	it("survives no pushes at all without dividing by zero", () => {
		expect(pushCommitStats([])).toMatchObject({
			pushes: 0,
			mean: 0,
			median: 0,
			singleCommitShare: 0,
			docsOnlyShare: 0,
		});
	});
});

describe("dailySeries", () => {
	it("fills a day with no runs at all with zero, not a gap", () => {
		const perDay = [
			{ day: "2026-08-14", billed: 10 },
			{ day: "2026-08-16", billed: 30 },
		];
		expect(dailySeries(perDay, "2026-08-14", "2026-08-16")).toEqual([
			10, 0, 30,
		]);
	});

	it("ignores a day outside the window asked for", () => {
		const perDay = [
			{ day: "2026-08-13", billed: 99 },
			{ day: "2026-08-14", billed: 10 },
		];
		expect(dailySeries(perDay, "2026-08-14", "2026-08-14")).toEqual([10]);
	});
});

describe("dailyMeanBand", () => {
	it("puts a 95% band on the daily mean with Student's t, not the normal", () => {
		const b = dailyMeanBand([50, 75, 100, 125, 150]);
		expect(b.n).toBe(5);
		expect(b.mean).toBe(100);
		expect(b.sd).toBeCloseTo(39.53, 2);
		expect(b.halfWidth).toBeCloseTo(2.776 * (39.53 / Math.sqrt(5)), 1);
		expect(b.lo).toBeCloseTo(b.mean - b.halfWidth, 5);
		expect(b.hi).toBeCloseTo(b.mean + b.halfWidth, 5);
	});

	it("floors the low end at zero", () => {
		expect(dailyMeanBand([1, 1, 1, 1, 200]).lo).toBe(0);
	});

	it("refuses a band on fewer than two days rather than returning NaN", () => {
		expect(dailyMeanBand([100])).toBeNull();
		expect(dailyMeanBand([])).toBeNull();
	});

	it("projects the band onto a 30-day month", () => {
		const b = dailyMeanBand([50, 75, 100, 125, 150]);
		expect(b.monthlyLo).toBeCloseTo(b.lo * 30, 5);
		expect(b.monthlyHi).toBeCloseTo(b.hi * 30, 5);
	});
});

describe("clampUntil", () => {
	const now = new Date("2026-08-19T09:00:00Z");

	it("clamps a window running into today", () => {
		expect(clampUntil("2026-08-25", now)).toBe("2026-08-18");
		expect(clampUntil("2026-08-19", now)).toBe("2026-08-18");
	});

	it("leaves a window that already closed alone", () => {
		expect(clampUntil("2026-08-18", now)).toBe("2026-08-18");
		expect(clampUntil("2026-08-01", now)).toBe("2026-08-01");
	});
});

describe("dayWindows", () => {
	it("splits an inclusive window into one entry per UTC day", () => {
		expect(dayWindows("2026-08-14", "2026-08-18")).toEqual([
			"2026-08-14",
			"2026-08-15",
			"2026-08-16",
			"2026-08-17",
			"2026-08-18",
		]);
	});

	it("gives a single-day window one day, not none", () => {
		expect(dayWindows("2026-08-14", "2026-08-14")).toEqual(["2026-08-14"]);
	});

	it("keeps every day of the fortnight the re-measure runs", () => {
		/* A fortnight is the window mantahostels#676 was filed about — the one a single
		 * request would truncate. */
		expect(dayWindows("2026-08-15", "2026-08-28")).toHaveLength(14);
	});

	it("crosses a month boundary", () => {
		expect(dayWindows("2026-08-30", "2026-09-02")).toEqual([
			"2026-08-30",
			"2026-08-31",
			"2026-09-01",
			"2026-09-02",
		]);
	});

	it("yields nothing for a reversed window rather than looping", () => {
		expect(dayWindows("2026-08-18", "2026-08-14")).toEqual([]);
	});
});

describe("windowSpanDays", () => {
	it("counts an inclusive window, both ends", () => {
		expect(windowSpanDays("2026-08-14", "2026-08-18")).toBeCloseTo(5, 2);
		expect(windowSpanDays("2026-08-14", "2026-08-14")).toBeCloseTo(1, 2);
	});
});

describe("summarise — a run with no usable timestamp", () => {
	it("counts it in the totals and invents no day row", () => {
		const s = summarise(
			[
				{ id: 1, event: "push", head_sha: "a", created_at: null },
				{
					id: 2,
					event: "push",
					head_sha: "b",
					created_at: "2026-08-14T10:00:00Z",
				},
			],
			() => [job(60)],
		);
		expect(s.billed).toBe(2);
		expect(s.perDay.map((d: { day: string }) => d.day)).toEqual(["2026-08-14"]);
	});
});

describe("foldPushes — a push whose file list is incomplete", () => {
	const c = (sha: string, files: string[]) => ({ sha, files });

	it("is unclassifiable when any one commit listed no files", () => {
		const { pushes } = foldPushes([c("m", []), c("d", ["docs/x.md"])], ["d"]);
		expect(pushes[0].commits).toBe(2);
		expect(pushes[0].docsOnly).toBeNull();
	});

	it("still classifies a push whose commits all listed files", () => {
		const { pushes } = foldPushes(
			[c("a", ["docs/x.md"]), c("d", [".claude/y.json"])],
			["d"],
		);
		expect(pushes[0].docsOnly).toBe(true);
	});
});
