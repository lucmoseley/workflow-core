#!/usr/bin/env node
/*
 * check-suite-budget.js — is the whole suite's summed per-file CI time, each
 * file at its median over the last three sweeps, over the budget a 180 s
 * cold lone whole suite allows (#5137)?
 *
 * Usage:
 *   node check-suite-budget.js [--reports <dir>] [--json]
 *
 * Reads each sweep's vitest reports (`scripts/lib/sweep-reports.js`, where
 * `--reports <dir>` names sweeps already downloaded). The sum is
 * `scripts/lib/suite-budget.js`'s; the budget and the record that arms it are
 * SUITE_BUDGET_MS and BUDGET_ARMED_BY in `scripts/lib/suite-ceiling.js`.
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
const { SWEEPS_JUDGED } = require("./lib/file-ci-time.js");
const { judgeBudget } = require("./lib/suite-budget.js");
const { BUDGET_ARMED_BY } = require("./lib/suite-ceiling.js");
const { readSweeps } = require("./lib/sweep-reports.js");

/** @param {number} s */
const secs = (s) => `${Math.round(s)} s`;

runCheck({
	name: "suite-budget",
	usage: "node check-suite-budget.js [--reports <dir>] [--json]",
	valueFlags: ["--reports"],
	run(/** @type {import("./lib/check.js").Ctx} */ ctx) {
		const verdict = judgeBudget(readSweeps(ctx));
		if (!verdict.judged)
			ctx.skip(
				`judged nothing: ${verdict.runs.length} sweep(s) with vitest reports readable${verdict.runs.length > 0 ? ` (${verdict.runs.join(", ")})` : ""}, ${SWEEPS_JUDGED} needed for a median.`,
			);
		const { totalSeconds, budgetSeconds, files, slowest, runs } = verdict;
		const sum = `${files} test files' median CI times over their last ${SWEEPS_JUDGED} sweeps (latest ${runs.slice(0, SWEEPS_JUDGED).join(", ")}) sum to ${secs(totalSeconds)}`;
		const budget = `the ${secs(budgetSeconds)} budget a 180 s cold lone whole suite allows`;
		if (!verdict.over) return { okLine: `${sum}, inside ${budget}.` };
		const record = { totalSeconds, budgetSeconds, files, slowest };
		const text = `${sum}, ${secs(totalSeconds - budgetSeconds)} over ${budget}.`;
		if (verdict.refuses) ctx.fail("SUITE-BUDGET", text, record, "SUITE-BUDGET");
		else ctx.warn("SUITE-BUDGET", text, record, "SUITE-BUDGET");
		ctx.say(`SUITE-BUDGET — ${text} Slowest:`);
		for (const f of slowest) ctx.say(`  ${secs(f.medianSeconds)}  ${f.file}`);
		ctx.say(
			verdict.refuses
				? `  Armed by ${BUDGET_ARMED_BY}: cut the slowest files by measured cost (#2729) before adding more.`
				: "  Reported only: no cold lone whole suite has yet passed under 180 s (BUDGET_ARMED_BY, scripts/lib/suite-ceiling.js).",
		);
		return { noun: "suite over its budget", count: 1, data: record };
	},
});
