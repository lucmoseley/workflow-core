#!/usr/bin/env node
/*
 * check-time-to-land.js — is the landing queue's take-to-land time within
 * its target (#4951)? lib/time-to-land.js reads and judges it.
 *
 * Usage:  node scripts/check-time-to-land.js [--since <ISO time>] [--until <ISO time>]
 *                                       [--notify] [--json]
 *
 * `--since` and `--until` set the window in place of the last 7 days, so a
 * change's own stays are read apart from those before it
 * (lib/time-to-land.js THE WINDOW).
 *
 * With no green run it names the window as unjudged and warns of nothing.
 *
 * WARN-ONLY, ALWAYS, as check-suite-margin.js is (#1797).
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js) where the `landing` module is on, reads the queue log and the tail of the lander's log and warns where enough of the window's queue refs, the last 7 days by default, took from first take to land or drop over 3 times the green suite's p50 run that a queue with its p90 on target would show as many at most 5% of the time. It refuses nothing.
 * JUSTIFIED: fail-safe — the queue's alerts read a ref's wait against the queue's own past week, so a queue slow every week reads as normal and nothing else holds it to the suite's time.
 * DEFEAT:    none needed — it never blocks.
 */

const { now, runCheck } = require("./lib/check");
const { landerLog } = require("./lib/lander-start.js");
const { queueLogFile, readQueueRows } = require("./lib/queue-log.js");
const { scriptPath } = require("./lib/script-path.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const {
	TARGET_MULTIPLE,
	greenSuiteSpans,
	memberStays,
	parseLanderLog,
	readLogSince,
	judgeTimeToLand,
	secs,
	windowOf,
} = require("./lib/time-to-land.js");

runCheck({
	name: "time-to-land",
	usage:
		"node check-time-to-land.js [--since <ISO time>] [--until <ISO time>] [--notify] [--json]",
	module: "landing",
	valueFlags: ["--since", "--until"],
	run(ctx) {
		const root = repoRoot() ?? ctx.skip("not in a git checkout.");
		const w = windowOf(
			{ since: ctx.value("--since"), until: ctx.value("--until") },
			now(),
		);
		if (typeof w === "string") return ctx.usageError(w);
		const r = judgeTimeToLand(
			memberStays(readQueueRows(queueLogFile(root))),
			greenSuiteSpans(parseLanderLog(readLogSince(landerLog(root), w.since))),
			w,
		);
		const reading = `take-to-land p90 ${secs(r.p90Ms)} s, p50 ${secs(r.p50Ms)} s, over ${r.stays} queue ref(s) taken and landed or dropped ${w.label}; target ${secs(r.targetMs)} s, ${TARGET_MULTIPLE} times the green suite's p50 of ${secs(r.greenP50Ms)} s over ${r.greens} run(s); ${r.overTarget ?? "-"} of ${r.stays} over the target, ${r.needed} calling it over`;
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
				: `time-to-land unjudged: no green run ${w.label} to set a target; ${r.stays} queue ref(s) taken and landed or dropped.`,
			noun: "landing queue over its time-to-land target",
			count: r.over ? 1 : 0,
			data: r,
		};
	},
});
