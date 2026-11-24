#!/usr/bin/env node

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
		const reading = `take-to-land p90 ${secs(r.p90Ms)} s, p50 ${secs(r.p50Ms)} s, over ${r.stays} queue ref(s) taken and landed or dropped ${w.label}; target ${secs(r.targetMs)} s, ${TARGET_MULTIPLE} times the green suite's p50 of ${secs(r.greenP50Ms)} s over ${r.greens} run(s); ${r.overTarget ?? "-"} of ${r.stays} over the target, ${r.overNeeded} calling it over`;
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
