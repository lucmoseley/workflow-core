#!/usr/bin/env node
/*
 * check-landing-stall.js — name a stalled or lander-less landing queue at
 * session start (workflow-core#2406, workflow-core#4458). lib/landing-stall.js judges the reading.
 *
 * Usage:  node scripts/check-landing-stall.js [--notify] [--json]
 *
 * A LANDER STARTING BESIDE IT. The session start that runs this also starts
 * the queue lander, so a reading of no lander is taken again after
 * START_GRACE_MS before it is named. WFC_LANDER_START_GRACE_MS replaces the
 * grace, for tests.
 *
 * THE QUEUE'S LIMITS. It also names the oldest waiting queue ref past its
 * limit, and a queue deeper than its limit (lib/queue-gauge.js), at every
 * session start while either stands; the refill loop's queue alert
 * (lib/queue-alert.js) is the one that fires once per crossing.
 *
 * Where the `landing` module is off it prints nothing under --notify.
 *
 * IMPLICIT:  at every session start where the `landing` module is on, reads the remote's `main` and queue refs, fetching their commits where missing, the queue log and the queue lander's heartbeat, and warns where a queue ref waits and `main` has not moved for 2 h since the oldest waiting ref's push and the machine's last boot or resume, or where a queue ref waits and no queue lander is running; and warns where the oldest waiting queue ref has waited past twice the 7-day p90 time in queue (floor 60 min), or more refs wait than twice the 7-day p90 depth (floor 10).
 * JUSTIFIED: fail-safe — the lander runs outside any session, so nothing else reports it stalling or dying.
 * DEFEAT:    none needed — it never blocks.
 */

const { now, runCheck } = require("./lib/check");
const { readQueue, stallFindings } = require("./lib/landing-stall.js");
const {
	buildCrossingLines,
	oldestWaiting,
	queueCrossings,
} = require("./lib/queue-gauge.js");
const { scriptPath } = require("./lib/script-path.js");
const { sleepSync } = require("./lib/sleep-sync.js");
const { repoRoot } = require("./lib/test-pass-marker.js");

/* Untraced: a lander's first beat follows its node start and lock, well
 * under a second. */
const START_GRACE_MS = 15 * 1000;

runCheck({
	name: "landing-stall",
	usage: "node check-landing-stall.js [--notify] [--json]",
	module: "landing",
	run(ctx) {
		const root = repoRoot() ?? ctx.skip("not in a git checkout.");
		let queue = readQueue(root, now());
		let found = stallFindings(queue);
		if (found.some((f) => f.tag === "LANDER-DEAD")) {
			sleepSync(
				Number(process.env.WFC_LANDER_START_GRACE_MS ?? START_GRACE_MS),
			);
			queue = readQueue(root, now());
			found = stallFindings(queue);
		}
		const crossed = buildCrossingLines(
			queueCrossings(queue.gauge),
			queue.gauge.baseline,
		);
		const all = [
			...found,
			...(crossed.age ? [{ tag: "QUEUE-STALLED", line: crossed.age }] : []),
			...(crossed.depth ? [{ tag: "QUEUE-DEEP", line: crossed.depth }] : []),
		];
		for (const f of all) {
			ctx.warn(f.tag, f.line);
			ctx.say(`${f.tag} — ${f.line}\n`);
		}
		if (all.length > 0)
			ctx.say(
				`  Run the queue lander by hand to see where it stops: node ${scriptPath("queue-lander.js")} run\n`,
			);
		const oldest = oldestWaiting(queue.gauge.waiting);
		return {
			okLine: "the landing queue is moving.",
			noun: "landing queue finding(s)",
			count: all.length,
			data: {
				queueWaiting: queue.gauge.waiting.length,
				oldest: oldest && `queue/${oldest.name}`,
				main: queue.main,
				movedAt: queue.movedAt,
			},
		};
	},
});
