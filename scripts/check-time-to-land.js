#!/usr/bin/env node
/*
 * check-time-to-land.js — is the landing queue's take-to-land time within
 * its target (#4951)? lib/time-to-land.js reads and judges it.
 *
 * Usage:  node scripts/check-time-to-land.js [--notify] [--json]
 *
 * With fewer than MIN_STAYS stays, or no green run, it names the window as
 * unjudged and warns of nothing.
 *
 * WARN-ONLY, ALWAYS, as check-suite-margin.js is (#1797).
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js) where the `landing` module is on, reads the queue log and the tail of the lander's log and warns where the last 7 days' p90 time from a queue ref's first take to its land or drop is over 3 times the green suite's p50 run. It refuses nothing.
 * JUSTIFIED: fail-safe — the queue's alerts read a ref's wait against the queue's own past week, so a queue slow every week reads as normal and nothing else holds it to the suite's time.
 * DEFEAT:    none needed — it never blocks.
 */

const { now, runCheck } = require("./lib/check");
const { landerLog } = require("./lib/lander-start.js");
const {
	BASELINE_MS,
	queueLogFile,
	readQueueRows,
} = require("./lib/queue-log.js");
const { scriptPath } = require("./lib/script-path.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const {
	MIN_STAYS,
	TARGET_MULTIPLE,
	greenSuiteSpans,
	memberStays,
	parseLanderLog,
	readLogSince,
	judgeTimeToLand,
	secs,
} = require("./lib/time-to-land.js");

runCheck({
	name: "time-to-land",
	usage: "node check-time-to-land.js [--notify] [--json]",
	module: "landing",
	run(ctx) {
		const root = repoRoot() ?? ctx.skip("not in a git checkout.");
		const at = now();
		const r = judgeTimeToLand(
			memberStays(readQueueRows(queueLogFile(root))),
			greenSuiteSpans(
				parseLanderLog(readLogSince(landerLog(root), at - BASELINE_MS)),
			),
			at,
		);
		const reading = `take-to-land p90 ${secs(r.p90Ms)} s, p50 ${secs(r.p50Ms)} s, over ${r.stays} queue ref(s) landed or dropped in 7 days; target ${secs(r.targetMs)} s, ${TARGET_MULTIPLE} times the green suite's p50 of ${secs(r.greenP50Ms)} s over ${r.greens} run(s)`;
		if (r.over) {
			ctx.warn("SLOW-LANDING", reading);
			ctx.say(`SLOW-LANDING — ${reading}\n`);
			ctx.say(
				`  Where the time goes, step by step: node ${scriptPath("time-to-land.js")}\n`,
			);
		}
		return {
			okLine: r.judged
				? `${reading}.`
				: `time-to-land unjudged: ${r.stays} queue ref(s) landed or dropped in 7 days, under the ${MIN_STAYS} a p90 needs, or no green run.`,
			noun: "landing queue over its time-to-land target",
			count: r.over ? 1 : 0,
			data: r,
		};
	},
});
