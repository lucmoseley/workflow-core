#!/usr/bin/env node
/*
 * check-time-to-land.js — is the landing queue's take-to-land time within
 * its target (#4951)? lib/time-to-land.js reads and judges it.
 *
 * Usage:  node scripts/check-time-to-land.js [--notify] [--json]
 *
 * A queue ref's stay runs from the lander's first take of it to its land or
 * drop. Over the last 7 days the stays' p90 is held to TARGET_MULTIPLE times
 * the green suite's p50, the lander log's `test-sha` to `fast-forward-main`
 * at one sha. With fewer than MIN_STAYS stays, or no green run, it names the
 * window as unjudged and warns of nothing.
 *
 * WARN-ONLY, ALWAYS, as check-suite-margin.js is (#1797).
 *
 * Where the `landing` module is off it prints nothing under --notify.
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
	readTimeToLand,
} = require("./lib/time-to-land.js");

/** @param {number|null} ms */
const secs = (ms) =>
	ms === null ? "no reading" : `${Math.round(ms / 1000)} s`;

runCheck({
	name: "time-to-land",
	usage: "node check-time-to-land.js [--notify] [--json]",
	module: "landing",
	run(ctx) {
		const root = repoRoot() ?? ctx.skip("not in a git checkout.");
		const at = now();
		const r = readTimeToLand(
			memberStays(readQueueRows(queueLogFile(root))),
			greenSuiteSpans(
				parseLanderLog(readLogSince(landerLog(root), at - BASELINE_MS)),
			),
			at,
		);
		const reading = `take-to-land p90 ${secs(r.p90Ms)}, p50 ${secs(r.p50Ms)}, over ${r.stays} queue ref(s) landed or dropped in 7 days; target ${secs(r.targetMs)}, ${TARGET_MULTIPLE} times the green suite's p50 of ${secs(r.greenP50Ms)} over ${r.greens} run(s)`;
		if (r.over) {
			ctx.warn("SLOW-LANDING", reading);
			ctx.say(`SLOW-LANDING — ${reading}\n`);
			ctx.say(
				`  Where the time goes, step by step: node ${scriptPath("report-time-to-land.js")}\n`,
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
