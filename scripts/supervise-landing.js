#!/usr/bin/env node
/*
 * supervise-landing.js — one supervision pass over the landing queue of the
 * checkout it runs in (#2692, ruled at #2672), which the refill loop runs in
 * every served or launched-in checkout each tick: where `landing` is ahead
 * of `main` and no lander runs, it starts one through start-lander.js; where
 * `main` has not moved for lib/landing-stall.js's STALL_MS, it files or
 * refreshes the stall ticket (lib/stall-ticket.js), which it closes once
 * `main` moves. A held queue it leaves to the held-queue issue. It files
 * the queue alert (lib/queue-alert.js) once per crossing of a queue limit
 * (lib/queue-gauge.js), and closes it once the queue is back within it.
 *
 *   node scripts/supervise-landing.js [--tester <command>]
 *
 * `--tester` is the started lander's, as start-lander.js passes it on.
 *
 * Prints nothing where the `landing`
 * module is off or the queue needs nothing. Joins no §N3 family: it gates
 * nothing and is no hook.
 *
 * Exit codes: 0 on a pass; 1 on a throw, an unreadable remote, a failed start
 * or a refused filing among them; 2 on a command line it refuses.
 */

const { parseErrorText } = require("./lib/caught.js");
const { now } = require("./lib/check.js");
const { flagValue, parseOrCode } = require("./lib/cli-args.js");
const { runStartLander } = require("./lib/lander-start.js");
const {
	mainMovedAt,
	readQueue,
	supervision,
} = require("./lib/landing-stall.js");
const { markersDir } = require("./lib/marker-root.js");
const { queueAlertTender } = require("./lib/queue-alert.js");
const { queueCrossings, readQueueGauge } = require("./lib/queue-gauge.js");
const { liveQueueDeps } = require("./lib/queue-issue.js");
const { scriptPath } = require("./lib/script-path.js");
const { stallTicketTender } = require("./lib/stall-ticket.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const { moduleOn } = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("supervise-landing.js")} [--tester <command>]`;

/** @type {import("./lib/cli-args.js").CliSpec} */
const CLI = { usage: USAGE, flags: { "--tester": "value" } };

/** @param {string} line */
const say = (line) => writeFd(1, `${line}\n`);

/** @param {string[]} [argv] @returns {number} */
function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	const root = repoRoot();
	if (root === null) {
		writeFd(2, "supervise-landing: not in a git checkout\n");
		return 1;
	}
	if (!moduleOn("landing", { root })) return 0;
	const queue = readQueue(root);
	const { start, ticket } = supervision(queue);
	if (start) startLander(root, flagValue(parsed.flags, "--tester"));
	const deps = liveQueueDeps(root);
	const tend = stallTicketTender(deps, markersDir(root));
	for (const line of tend({
		main: queue.main,
		movedAt: mainMovedAt(queue.mainAt, queue.heartbeat),
		stall: ticket && {
			landing: ticket.landing,
			movedAt: new Date(ticket.movedAt).toISOString(),
			batch: queue.heartbeat?.batch ?? null,
			red: queue.heartbeat?.red ?? null,
		},
	}))
		say(line);
	const gauge = readQueueGauge(root, now());
	const alert = queueAlertTender(deps, markersDir(root));
	for (const line of alert(gauge, queueCrossings(gauge))) say(line);
	return 0;
}

/**
 * start-lander.js in `root`, naming the refill loop its launcher; its line is
 * printed and appended to the lander's log.
 * @param {string} root
 * @param {string|undefined} tester
 */
function startLander(root, tester) {
	const r = runStartLander(root, {
		args: [
			"--launched-by",
			"the refill loop",
			...(tester === undefined ? [] : ["--tester", tester]),
		],
	});
	if (!r.ok) throw new Error(r.line);
	say(r.line);
}

if (require.main === module) {
	try {
		process.exit(main());
	} catch (err) {
		writeFd(2, `supervise-landing: ${parseErrorText(err)}\n`);
		process.exit(1);
	}
}

module.exports = { main };
