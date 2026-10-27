#!/usr/bin/env node
/*
 * check-landing-stall.js — name a stalled, held or lander-less landing queue
 * at session start (workflow-core#2406, spec workflow-core#2261). lib/landing-stall.js judges the
 * reading.
 *
 * Usage:  node scripts/check-landing-stall.js [--notify] [--json]
 *
 * A LANDER STARTING BESIDE IT. The session start that runs this also starts
 * the lander, so a reading of no lander is taken again after START_GRACE_MS
 * before it is named. WFC_LANDER_START_GRACE_MS replaces the grace, for
 * tests.
 *
 * Where the `landing` module is off it prints nothing under --notify.
 *
 * IMPLICIT:  at every session start where the `landing` module is on, reads the remote's two branches, fetching their commits where missing, and warns where `landing` holds commits `main` lacks and `main` has not moved for 2 h, or where `landing` is ahead and no lander is running.
 * JUSTIFIED: fail-safe — the lander runs outside any session, so nothing else reports it stalling or dying.
 * DEFEAT:    none needed — it never blocks.
 */

const { runCheck } = require("./lib/check");
const { readQueue, stallFindings } = require("./lib/landing-stall.js");
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
		for (const f of found) {
			ctx.warn(f.tag, f.line);
			ctx.say(`${f.tag} — ${f.line}\n`);
		}
		if (found.length > 0)
			ctx.say(
				`  Run the lander by hand to see where it stops: node ${scriptPath("lander.js")} run\n`,
			);
		return {
			okLine: "the landing queue is moving.",
			noun: "landing queue finding(s)",
			count: found.length,
			data: {
				main: queue.main,
				landing: queue.landing,
				relation: queue.relation,
				mainAt: queue.mainAt,
			},
		};
	},
});
