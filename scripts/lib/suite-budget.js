const { SWEEPS_JUDGED, median, readingsByFile } = require("./file-ci-time.js");
const { BUDGET_ARMED_BY, SUITE_BUDGET_MS } = require("./suite-ceiling.js");

const ARMED_ENV = "WFC_SUITE_BUDGET_ARMED_BY";
// guess, #5137
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
 * @param {import("./file-ci-time.js").Sweep[]} sweeps
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
