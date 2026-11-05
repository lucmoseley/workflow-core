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
 * (lib/local-tester.js). `--tester` swaps in `<command> <sha> [<file>…]` as
 * scripts/lander.js takes it (lib/lander-cli.js).
 *
 * It holds the landing lander's lock, so the two never run at once, and moves
 * `main` only past that lander's green ledger, which the pre-push gate on
 * `main` reads. After each move of `main` it takes the same step that lander
 * does (lib/lander-cli.js).
 *
 * Does nothing where the `landing` module is off. Joins no §N3 family: it
 * gates nothing and is no hook.
 *
 * Exit codes: 0 on any exit the lander reaches, a held lock and a failed git
 * call included; 1 on a throw before the run; 2 on a command line it refuses.
 */

const { parseErrorText } = require("./lib/caught.js");
const { flagValue, parseOrCode } = require("./lib/cli-args.js");
const { queueTester } = require("./lib/actions-tester.js");
const { afterMainMove, commandTester } = require("./lib/lander-cli.js");
const {
	fileLedger,
	heartbeatWriter,
	landerFiles,
	landerLock,
} = require("./lib/lander.js");
const { localTester } = require("./lib/local-tester.js");
const {
	batchRecord,
	queueGit,
	queueLanderFiles,
	verdictLedger,
} = require("./lib/queue-lander-adapters.js");
const {
	buildQueueActionLine,
	runQueueLander,
} = require("./lib/queue-lander.js");
const { scriptPath } = require("./lib/script-path.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const {
	buildModuleOffLine,
	moduleOn,
	readConfig,
} = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("queue-lander.js")} run [--tester <command>]
  without --tester, the tester .claude/workflow-core.json's landingTester names
  <command> <sha> [<file>…] exits 0 green, 1 red (stdout: failing files),
  else no verdict`;

/** @type {import("./lib/cli-args.js").CliSpec} */
const CLI = {
	usage: USAGE,
	commands: { run: { usage: USAGE, flags: { "--tester": "value" } } },
};

/** @param {string} line */
const say = (line) => writeFd(1, `${line}\n`);

/**
 * @param {string} root
 * @returns {import("./lib/lander.js").QueueTester}
 */
const configuredTester = (root) =>
	readConfig({ root, quiet: true }).landingTester === "actions"
		? queueTester({ root })
		: localTester({ root });

/** @param {string[]} [argv] @returns {Promise<number>} */
async function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	const tester = flagValue(parsed.flags, "--tester");
	const root = repoRoot();
	if (root === null) {
		writeFd(2, "queue-lander: not in a git checkout\n");
		return 1;
	}
	if (!moduleOn("landing", { root })) {
		say(`SKIP: ${buildModuleOffLine("landing")}`);
		return 0;
	}
	const files = queueLanderFiles(root);
	const beat = heartbeatWriter(files.heartbeat);
	await runQueueLander({
		git: queueGit(root),
		tester:
			tester === undefined
				? configuredTester(root)
				: commandTester(tester, root),
		ledger: fileLedger(landerFiles(root).ledger),
		verdicts: verdictLedger(files.verdicts),
		record: batchRecord(files.batch),
		lock: landerLock(root),
		beat: (batch) => beat(batch),
		log: (a) => say(`${new Date().toISOString()} ${buildQueueActionLine(a)}`),
		mainMoved: () => afterMainMove(root, say),
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
