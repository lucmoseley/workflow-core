#!/usr/bin/env node

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
