#!/usr/bin/env node

const { now, runCheck } = require("./lib/check");
const { readQueue, stallFindings } = require("./lib/landing-stall.js");
const { queueBranch } = require("./lib/landing-refs.js");
const {
	buildCrossingLines,
	oldestWaiting,
	queueCrossings,
} = require("./lib/queue-gauge.js");
const { scriptPath } = require("./lib/script-path.js");
const { sleepSync } = require("./lib/sleep-sync.js");
const { repoRoot } = require("./lib/test-pass-marker.js");

// guess: a lander's first beat comes well under a second in, #2406
const START_GRACE_MS = 15 * 1000;

runCheck({
	name: "landing-stall",
	usage: "node check-landing-stall.js [--notify] [--json]",
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
		const hung = found.some((f) => f.tag === "LANDER-HUNG")
			? queue.heartbeat?.pid
			: undefined;
		if (hung !== undefined)
			ctx.say(
				`  The hung lander holds the lander lock, so a run by hand exits lock-held; see what it is stuck in: ps -o pid,etime,args -p ${hung} --ppid ${hung}\n`,
			);
		else if (all.length > 0)
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
				oldest: oldest && queueBranch(oldest.name),
				main: queue.main,
				movedAt: queue.movedAt,
			},
		};
	},
});
