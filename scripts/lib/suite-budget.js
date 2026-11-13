/*
 * suite-budget.js — whether the whole suite's summed per-file CI time is over
 * SUITE_BUDGET_MS (#5137), and whether that refuses.
 *
 * THE SUM IS EACH FILE'S MEDIAN over its latest SWEEPS_JUDGED sweeps, the
 * files and readings `scripts/lib/file-ci-time.js` takes, so one slow sweep
 * moves no file that has three readings. A file timed in fewer, a new one say,
 * counts at the median of what it has: growth counts from its first sweep.
 *
 * IT REFUSES ONLY ONCE ARMED, BUDGET_ARMED_BY in `scripts/lib/suite-ceiling.js`
 * naming the cold lone whole suite that first passed under TARGET_MS. Before
 * that an over-budget sum is reported.
 */

const { SWEEPS_JUDGED, median, readingsByFile } = require("./file-ci-time.js");
const { BUDGET_ARMED_BY, SUITE_BUDGET_MS } = require("./suite-ceiling.js");

/* The files a finding names, slowest first. Untraced. */
const NAMED = 10;

/**
 * @typedef {{ file: string, medianSeconds: number }} FileMedian
 * @typedef {{ judged: false, runs: string[] }
 *   | { judged: true, runs: string[], totalSeconds: number,
 *       budgetSeconds: number, over: boolean, refuses: boolean,
 *       files: number, slowest: FileMedian[] }} Verdict
 */

/**
 * @param {import("./file-ci-time.js").Sweep[]} sweeps newest first
 * @param {{ armedBy?: string|null, budgetMs?: number }} [options]
 * @returns {Verdict}
 */
function judgeBudget(
	sweeps,
	{ armedBy = BUDGET_ARMED_BY, budgetMs = SUITE_BUDGET_MS } = {},
) {
	const runs = sweeps.map((s) => s.run);
	if (sweeps.length < SWEEPS_JUDGED) return { judged: false, runs };
	/** @type {FileMedian[]} */
	const medians = [...readingsByFile(sweeps)].map(([file, readings]) => ({
		file,
		medianSeconds: median(readings.map((r) => r.seconds)),
	}));
	medians.sort(
		(a, b) => b.medianSeconds - a.medianSeconds || a.file.localeCompare(b.file),
	);
	const totalSeconds = medians.reduce((sum, f) => sum + f.medianSeconds, 0);
	const over = totalSeconds * 1000 > budgetMs;
	return {
		judged: true,
		runs,
		totalSeconds,
		budgetSeconds: budgetMs / 1000,
		over,
		refuses: over && armedBy !== null,
		files: medians.length,
		slowest: medians.slice(0, NAMED),
	};
}

module.exports = { judgeBudget };
