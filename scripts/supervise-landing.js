#!/usr/bin/env node
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
	const deps = liveQueueDeps(root);
	// #4772
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
 * @param {string} root
 * @param {import("./lib/queue-issue.js").QueueIssueDeps} deps
 * @returns {boolean}
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
