#!/usr/bin/env node
/*
 * queue-lander.js — one queue lander run (#4485, spec #4458): while any
 * `queue/<name>` ref waits on the remote, take them all as one batch, merge
 * them onto `main`, test the integration commit and move `main` to it on
 * green (lib/queue-lander.js).
 *
 *   node scripts/queue-lander.js run [--tester <command>]
 *
 * The tester is the one `landingTester` in .claude/workflow-core.json names:
 * the Actions one (lib/actions-tester.js's queueTester), reading the suite
 * run a push to `lander/batch` starts, or else the local one
 * (lib/local-tester.js). `--tester` swaps in a command, and after each move
 * of `main` it takes the step lib/lander-cli.js holds.
 *
 * It moves `main` only past the landing lander's green ledger, which the
 * pre-push gate on `main` reads. A dropped member's fix ticket is filed in
 * the tracker .claude/workflow-core.json names, through file-issue.js.
 *
 * Does nothing where the `landing` module is off. Joins no §N3 family: it
 * gates nothing and is no hook.
 *
 * cli-args-exempt: lib/lander-cli.js's openLanderRun parses it, through
 * lib/cli-args.js.
 *
 * Exit codes: 0 on any exit the lander reaches, a held lock and a failed git
 * call included; 1 on a throw before the run; 2 on a command line it refuses.
 */

const { parseErrorText } = require("./lib/caught.js");
const { now } = require("./lib/check.js");
const { queueTester } = require("./lib/actions-tester.js");
const { dropTicketFiler, liveFilerDeps } = require("./lib/fix-ticket.js");
const {
	afterMainMove,
	commandTester,
	openLanderRun,
	say,
	stampedLog,
} = require("./lib/lander-cli.js");
const {
	fileLedger,
	heartbeatWriter,
	landerFiles,
	landerLock,
} = require("./lib/lander.js");
const { localTester } = require("./lib/local-tester.js");
const {
	batchRecord,
	dropRecord,
	queueGit,
	queueLanderFiles,
	queueLogger,
	verdictLedger,
} = require("./lib/queue-lander-adapters.js");
const {
	buildQueueActionLine,
	runQueueLander,
} = require("./lib/queue-lander.js");
const { readConfig } = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

/**
 * @param {string} root
 * @returns {import("./lib/lander.js").QueueTester}
 */
const configuredTester = (root) =>
	readConfig({ root, quiet: true }).landingTester === "actions"
		? queueTester({ root })
		: localTester({ root });

/**
 * @param {string} root
 * @returns {import("./lib/queue-lander.js").QueueTracker}
 */
function trackerOf(root) {
	const deps = liveFilerDeps(root);
	return { ...dropTicketFiler(deps), stateOf: deps.stateOf };
}

/** @param {string[]} [argv] @returns {Promise<number>} */
async function main(argv = process.argv.slice(2)) {
	const opened = openLanderRun(argv, "queue-lander.js");
	if (typeof opened === "number") return opened;
	const { root, tester } = opened;
	const files = queueLanderFiles(root);
	await runQueueLander({
		git: queueGit(root),
		tester:
			tester === undefined
				? configuredTester(root)
				: commandTester(tester, root),
		ledger: fileLedger(landerFiles(root).ledger),
		verdicts: verdictLedger(files.verdicts),
		record: batchRecord(files.batch),
		drops: dropRecord(files.drops),
		tracker: trackerOf(root),
		logQueue: queueLogger(root),
		lock: landerLock(root),
		beat: heartbeatWriter(files.heartbeat),
		log: stampedLog(buildQueueActionLine),
		mainMoved: () => afterMainMove(root),
		now,
		say,
	});
	return 0;
}

if (require.main === module)
	main().then(
		(code) => process.exit(code),
		(err) => {
			writeFd(2, `queue-lander: ${parseErrorText(err)}\n`);
			process.exit(1);
		},
	);

module.exports = { main };
