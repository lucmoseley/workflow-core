#!/usr/bin/env node
/*
 * supervise-landing.js — one supervision pass over the landing queue of the
 * checkout it runs in (workflow-core#2692, ruled at workflow-core#2672), which the refill loop runs in
 * every served or launched-in checkout each tick: lib/landing-stall.js reads
 * the queue and decides. Where a queue ref waits and no queue lander runs, it
 * starts one through start-lander.js, the one launcher; where `main` has not
 * moved for STALL_MS with a queue ref waiting, it files or refreshes the
 * stall ticket (lib/stall-ticket.js), which it closes once `main` moves. It
 * files and closes the queue alert (lib/queue-alert.js), and the alarm ticket
 * while an off-machine queue alarm fires (lib/alarm-ticket.js, workflow-core#4772).
 *
 *   node scripts/supervise-landing.js [--tester <command>]
 *
 * `--tester` is the started lander's, as start-lander.js passes it on.
 *
 * Prints nothing where the `landing`
 * module is off or the queue needs nothing. Joins no §N3 family: it gates
 * nothing and is no hook.
 *
 * Exit codes: 0 on a pass; 1 on a throw, an alarm read that failed, an
 * unreadable remote or queue log, a failed start or a refused filing among
 * them; 2 on a command line it refuses.
 */

const { alarmTicketTender } = require("./lib/alarm-ticket.js");
const { parseErrorText } = require("./lib/caught.js");
const { now } = require("./lib/check.js");
const { flagValue, parseOrCode } = require("./lib/cli-args.js");
const { parseFirstLine } = require("./lib/first-line.js");
const { runStartLander } = require("./lib/lander-start.js");
const { readQueue, supervision } = require("./lib/landing-stall.js");
const { markersDir } = require("./lib/marker-root.js");
const { queueAlertTender } = require("./lib/queue-alert.js");
const { queueCrossings } = require("./lib/queue-gauge.js");
const { readFiringAlarms } = require("./lib/queue-alarms.js");
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
	const deps = liveQueueDeps(root);
	/* First and off the queue's reads, so a broken queue, when the alarms
	 * matter most, cannot skip them (workflow-core#4772). */
	const alarmsRead = tendAlarms(root, deps);
	const queue = readQueue(root, now());
	const { start, ticket } = supervision(queue);
	if (start) startLander(root, flagValue(parsed.flags, "--tester"));
	const tend = stallTicketTender(deps, markersDir(root));
	for (const line of tend({
		main: queue.main,
		movedAt: queue.movedAt,
		stall: ticket && {
			waiting: ticket.waiting,
			movedAt: new Date(ticket.movedAt).toISOString(),
			batch: queue.heartbeat?.batch ?? null,
		},
	}))
		say(line);
	const alert = queueAlertTender(deps, markersDir(root));
	for (const line of alert(queue.gauge, queueCrossings(queue.gauge))) say(line);
	return alarmsRead ? 0 : 1;
}

/**
 * The alarm ticket's pass. An unread alarm is named and leaves the ticket as
 * it stands; the pass goes on, and fails at its end (workflow-core#4772).
 * @param {string} root
 * @param {import("./lib/queue-issue.js").QueueIssueDeps} deps
 * @returns {boolean} whether the alarms read
 */
function tendAlarms(root, deps) {
	let alarms;
	try {
		alarms = readFiringAlarms(root);
	} catch (e) {
		say(`queue alarms: not read: ${parseFirstLine(parseErrorText(e))}`);
		return false;
	}
	const tend = alarmTicketTender(deps, markersDir(root));
	for (const line of tend(alarms)) say(line);
	return true;
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
