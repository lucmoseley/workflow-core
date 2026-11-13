#!/usr/bin/env node
/*
 * check-suite-budget.js — is the whole suite's summed per-file CI time, each
 * file at its median over the last three sweeps, over the budget a cold lone
 * whole suite at its target allows (#5137)?
 *
 * Usage:
 *   node check-suite-budget.js [--reports <dir>] [--json]
 *
 * Reads each sweep's vitest reports (`scripts/lib/sweep-reports.js`, where
 * `--reports <dir>` names sweeps already downloaded). What is summed, and what
 * refuses, is `scripts/lib/suite-budget.js`'s; the budget and the record that
 * arms it are SUITE_BUDGET_MS and BUDGET_ARMED_BY in
 * `scripts/lib/suite-ceiling.js`.
 *
 * IT REFUSES IN THE SCHEDULED SWEEP ALONE, on recorded medians: a commit has
 * no median for the file it adds, and one run's wall time judges the machine
 * as much as the suite.
 *
 * FEWER THAN THREE SWEEPS READABLE IS A SKIP THAT SAYS IT JUDGED NOTHING,
 * never an OK.
 *
 * IMPLICIT:  in the scheduled sweep (scheduled-checks.yml), sums each test file's median CI time over its last three sweeps, downloading those sweeps' vitest reports, and turns the sweep red where the sum is over the budget scripts/lib/suite-ceiling.js sets and that budget is armed; unarmed, it reports.
 * JUSTIFIED: fail-safe — the suite grows by about 20 files a day, and an unrefused budget lets it move the 180 s target (#2729) further off unseen (#5131).
 * DEFEAT:    convenience — --reports judges sweeps already downloaded, with no gh call.
 */

const { runCheck } = require("./lib/check.js");
const { SWEEPS_JUDGED, judgedNothing } = require("./lib/file-ci-time.js");
const { armedBy, judgeBudget } = require("./lib/suite-budget.js");
const { TARGET_MS } = require("./lib/suite-ceiling.js");
const { readSweeps } = require("./lib/sweep-reports.js");

/** @param {number} s */
const secs = (s) => `${Math.round(s)} s`;

const TARGET = secs(TARGET_MS / 1000);

/**
 * @param {boolean} refuses
 * @param {number} judgedSeconds
 */
function nextStep(refuses, judgedSeconds) {
	const armed = armedBy();
	if (refuses)
		return `  Armed by ${armed}: cut the slowest files by measured cost (#2729) before adding more.`;
	if (armed)
		return `  Not refused: the files timed in all ${SWEEPS_JUDGED} sweeps sum to ${secs(judgedSeconds)}, inside the budget; the rest are new.`;
	return `  Reported only: no cold lone whole suite has yet passed under ${TARGET} (BUDGET_ARMED_BY, scripts/lib/suite-ceiling.js).`;
}

runCheck({
	name: "suite-budget",
	usage: "node check-suite-budget.js [--reports <dir>] [--json]",
	valueFlags: ["--reports"],
	run(/** @type {import("./lib/check.js").Ctx} */ ctx) {
		const verdict = judgeBudget(readSweeps(ctx));
		if (!verdict.judged) ctx.skip(judgedNothing(verdict.runs));
		const { totalSeconds, judgedSeconds, budgetSeconds, files, slowest } =
			verdict;
		const sum = `${files} test files' median CI times over their last ${SWEEPS_JUDGED} sweeps (latest ${verdict.runs.slice(0, SWEEPS_JUDGED).join(", ")}) sum to ${secs(totalSeconds)}`;
		const budget = `the ${secs(budgetSeconds)} budget a ${TARGET} cold lone whole suite allows`;
		if (!verdict.over) return { okLine: `${sum}, inside ${budget}.` };
		const record = {
			totalSeconds,
			judgedSeconds,
			budgetSeconds,
			files,
			slowest,
		};
		const text = `${sum}, ${secs(totalSeconds - budgetSeconds)} over ${budget}.`;
		if (verdict.refuses) ctx.fail("SUITE-BUDGET", text, record, "SUITE-BUDGET");
		else ctx.warn("SUITE-BUDGET", text, record, "SUITE-BUDGET");
		ctx.say(`SUITE-BUDGET — ${text} Slowest:`);
		for (const f of slowest) ctx.say(`  ${secs(f.medianSeconds)}  ${f.file}`);
		ctx.say(nextStep(verdict.refuses, judgedSeconds));
		return { noun: "suite over its budget", count: 1, data: record };
	},
});
