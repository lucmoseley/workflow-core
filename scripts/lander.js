#!/usr/bin/env node
/*
 * lander.js — one lander run by hand (#2402, spec #2261): while the remote's
 * `landing` is ahead of `main`, test its tip and fast-forward `main` to it on
 * green; on red, rerun, bisect, revert the confirmed culprit and file its fix
 * ticket, or hold (#2404).
 *
 *   node scripts/lander.js run [--tester <command>]
 *
 * The tester is the one `landingTester` names in .claude/workflow-core.json:
 * the local one (lib/local-tester.js), the suite in the lander's own
 * worktree, or the Actions one (lib/actions-tester.js), the suite workflow's
 * push run on `landing`, handing the local one what no push run tests.
 * `--tester` swaps in a command, and after each move of `main` it takes the
 * step lib/lander-cli.js holds.
 *
 * Does nothing where the `landing` module is off. Joins no §N3 family: it
 * gates nothing and is no hook.
 *
 * cli-args-exempt: lib/lander-cli.js's openLanderRun parses it, through
 * lib/cli-args.js.
 *
 * Exit codes: 0 on any exit or hold the lander reaches, a held lock and a
 * failed git call included; 1 on a throw before the run; 2 on a command line
 * it refuses.
 */

const { parseErrorText } = require("./lib/caught.js");
const { liveFilerDeps, ticketFiler } = require("./lib/fix-ticket.js");
const { heldQueueFiler } = require("./lib/held-queue.js");
const {
	buildActionLine,
	fileLedger,
	heartbeatWriter,
	landerFiles,
	landerLock,
	readHeartbeat,
	remoteGit,
	runLander,
} = require("./lib/lander.js");
const { actionsTester, namedRerun } = require("./lib/actions-tester.js");
const { localTester } = require("./lib/local-tester.js");
const {
	afterMainMove,
	commandTester,
	openLanderRun,
	say,
	stampedLog,
} = require("./lib/lander-cli.js");
const { liveQueueDeps } = require("./lib/queue-issue.js");
const { readConfig } = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

/**
 * The tester `landingTester` names.
 * @param {string} root
 * @param {Pick<import("./lib/local-tester.js").LocalTesterOptions, "admit" | "exec">} [slots]
 *   a test's slot and exec
 * @returns {import("./lib/lander.js").Tester}
 */
function configuredTester(root, slots = {}) {
	if (readConfig({ root, quiet: true }).landingTester !== "actions")
		return localTester({ root, ...slots });
	return actionsTester({
		root,
		fallback: localTester({
			root,
			...slots,
			memoryShut: namedRerun({ root }),
		}),
	});
}

/** @param {string} root */
const liveFiler = (root) => ({
	...heldQueueFiler(liveQueueDeps(root)),
	...ticketFiler(liveFilerDeps(root)),
});

/** @param {string[]} [argv] @returns {Promise<number>} */
async function main(argv = process.argv.slice(2)) {
	const opened = openLanderRun(argv, "lander.js");
	if (typeof opened === "number") return opened;
	const { root, tester } = opened;
	const files = landerFiles(root);
	await runLander({
		git: remoteGit(root),
		tester:
			tester === undefined
				? configuredTester(root)
				: commandTester(tester, root),
		tracker: liveFiler(root),
		ledger: fileLedger(files.ledger),
		noVerdict: fileLedger(files.noVerdict),
		lock: landerLock(root),
		beat: heartbeatWriter(files.heartbeat),
		lastHold: () => readHeartbeat(files.heartbeat)?.hold ?? null,
		lastRed: () => readHeartbeat(files.heartbeat)?.red ?? null,
		lastOwed: () => readHeartbeat(files.heartbeat)?.owed ?? [],
		lastMoved: () => readHeartbeat(files.heartbeat)?.movedAt ?? null,
		log: stampedLog(buildActionLine),
		say,
		mainMoved: () => afterMainMove(root),
	});
	return 0;
}

if (require.main === module)
	main().then(
		(code) => process.exit(code),
		(err) => {
			writeFd(2, `lander: ${parseErrorText(err)}\n`);
			process.exit(1);
		},
	);

module.exports = { configuredTester, main };
