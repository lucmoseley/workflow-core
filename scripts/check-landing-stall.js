#!/usr/bin/env node
/*
 * check-landing-stall.js — name a stalled, held or lander-less landing queue
 * at session start (#2406, spec #2261). lib/landing-stall.js judges the
 * reading.
 *
 * Usage:  node scripts/check-landing-stall.js [--notify] [--json]
 *
 * A LANDER STARTING BESIDE IT. The session start that runs this also starts
 * the lander, so a reading of no lander is taken again after START_GRACE_MS
 * before it is named. WFC_LANDER_START_GRACE_MS replaces the grace, for
 * tests.
 *
 * THE QUEUE. With queue refs waiting, it also names the oldest one waiting
 * past its limit, and a queue deeper than its limit (lib/queue-gauge.js),
 * at every session start while either stands; the refill loop's queue alert
 * (lib/queue-alert.js) is the one that fires once per crossing. The check of
 * `landing` ahead of `main` runs beside it.
 *
 * Where the `landing` module is off it prints nothing under --notify.
 *
 * IMPLICIT:  at every session start where the `landing` module is on, reads the remote's two branches, fetching their commits where missing, and warns where `landing` holds commits `main` lacks and has for 2 h, since the machine last booted or resumed, without `main` moving, or where `landing` is ahead and no lander is running; and reads the remote's queue refs and the queue log, and warns where the oldest waiting queue ref has waited past twice the 7-day p90 time in queue (floor 60 min), or more refs wait than twice the 7-day p90 depth (floor 10).
 * JUSTIFIED: fail-safe — the lander runs outside any session, so nothing else reports it stalling or dying.
 * DEFEAT:    none needed — it never blocks.
 */

const { now, runCheck } = require("./lib/check");
const { readQueue, stallFindings } = require("./lib/landing-stall.js");
const {
	buildCrossingLines,
	queueCrossings,
	readQueueGauge,
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
		const queue = readQueue(root);
		let found = stallFindings(queue);
		if (found.some((f) => f.tag === "LANDER-DEAD")) {
			sleepSync(
				Number(process.env.WFC_LANDER_START_GRACE_MS ?? START_GRACE_MS),
			);
			found = stallFindings(readQueue(root));
		}
		const gauge = readQueueGauge(root, now());
		const crossed = buildCrossingLines(queueCrossings(gauge), gauge.baseline);
		const queued = [
			...(crossed.age ? [{ tag: "QUEUE-STALLED", line: crossed.age }] : []),
			...(crossed.depth ? [{ tag: "QUEUE-DEEP", line: crossed.depth }] : []),
		];
		for (const f of [...found, ...queued]) {
			ctx.warn(f.tag, f.line);
			ctx.say(`${f.tag} — ${f.line}\n`);
		}
		if (found.length > 0)
			ctx.say(
				`  Run the lander by hand to see where it stops: node ${scriptPath("lander.js")} run\n`,
			);
		if (queued.length > 0)
			ctx.say(
				`  Run the queue lander by hand to see where it stops: node ${scriptPath("queue-lander.js")} run\n`,
			);
		return {
			okLine: "the landing queue is moving.",
			noun: "landing queue finding(s)",
			count: found.length + queued.length,
			data: {
				queueWaiting: gauge.waiting.length,
				main: queue.main,
				landing: queue.landing,
				relation: queue.relation,
				mainAt: queue.mainAt,
			},
		};
	},
});
