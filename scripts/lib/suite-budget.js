/*
 * suite-budget.js — whether the whole suite's summed per-file CI time is over
 * SUITE_BUDGET_MS (#5137), and whether that refuses.
 *
 * THE FILES SUMMED ARE THOSE THE NEWEST SWEEP TIMED, each at its median over
 * its latest SWEEPS_JUDGED sweeps (`scripts/lib/file-ci-time.js`), so a file
 * deleted or renamed since counts nowhere. RESIDUAL: a file whose shard the
 * newest sweep lost counts nowhere either, which can only understate the sum.
 *
 * A REFUSAL COUNTS ONLY FILES WITH SWEEPS_JUDGED READINGS. A new file counts
 * towards the reported total from its first sweep, and towards a refusal from
 * its third.
 *
 * IT REFUSES ONLY ONCE ARMED: BUDGET_ARMED_BY in `scripts/lib/suite-ceiling.js`
 * names the cold lone whole suite that first passed under TARGET_MS. ARM
 * ONLY: ARMED_ENV may arm an unarmed budget, for tests; it never disarms one.
 */

const { SWEEPS_JUDGED, median, readingsByFile } = require("./file-ci-time.js");
const { BUDGET_ARMED_BY, SUITE_BUDGET_MS } = require("./suite-ceiling.js");

const ARMED_ENV = "WFC_SUITE_BUDGET_ARMED_BY";
/* Untraced. */
const SLOWEST_NAMED = 10;

/**
 * @typedef {{ file: string, medianSeconds: number, readings: number }} FileMedian
 * @typedef {{ judged: false, runs: string[] }
 *   | { judged: true, runs: string[], totalSeconds: number,
 *       judgedSeconds: number, budgetSeconds: number, over: boolean,
 *       refuses: boolean, files: number, slowest: FileMedian[] }} Verdict
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
const armedBy = (env = process.env) =>
	BUDGET_ARMED_BY ?? (env[ARMED_ENV] || null);

/** @param {FileMedian[]} files */
const sumOf = (files) => files.reduce((sum, f) => sum + f.medianSeconds, 0);

/**
 * @param {import("./file-ci-time.js").Sweep[]} sweeps newest first
 * @param {{ armed?: string|null, budgetMs?: number }} [options]
 * @returns {Verdict}
 */
function judgeBudget(
	sweeps,
	{ armed = armedBy(), budgetMs = SUITE_BUDGET_MS } = {},
) {
	const runs = sweeps.map((s) => s.run);
	const [newest] = sweeps;
	if (sweeps.length < SWEEPS_JUDGED || !newest) return { judged: false, runs };
	const live = new Set(newest.rows.map((r) => r.file));
	/** @type {FileMedian[]} */
	const medians = [...readingsByFile(sweeps)]
		.filter(([file]) => live.has(file))
		.map(([file, readings]) => ({
			file,
			medianSeconds: median(readings.map((r) => r.seconds)),
			readings: readings.length,
		}));
	medians.sort(
		(a, b) => b.medianSeconds - a.medianSeconds || a.file.localeCompare(b.file),
	);
	const totalSeconds = sumOf(medians);
	const judgedSeconds = sumOf(
		medians.filter((f) => f.readings >= SWEEPS_JUDGED),
	);
	return {
		judged: true,
		runs,
		totalSeconds,
		judgedSeconds,
		budgetSeconds: budgetMs / 1000,
		over: totalSeconds * 1000 > budgetMs,
		refuses: armed !== null && judgedSeconds * 1000 > budgetMs,
		files: medians.length,
		slowest: medians.slice(0, SLOWEST_NAMED),
	};
}

module.exports = { ARMED_ENV, armedBy, judgeBudget };
