#!/usr/bin/env node
/*
 * queue-lander.js — one queue lander run (#4485, spec #4458): while any
 * `queue/<name>` ref waits on the remote, take them all as one batch, merge
 * them onto `main`, test the integration commit and move `main` to it on
 * green; on red, isolate the members and drop each culprit
 * (lib/queue-lander.js).
 *
 *   node scripts/queue-lander.js run [--tester <command>]
 *
 * The tester is the one `landingTester` in .claude/workflow-core.json names:
 * the Actions one (lib/actions-tester.js's queueTester), reading the suite
 * run a push to `lander/batch` starts, or else the local one
 * (lib/local-tester.js). `--tester` swaps in a command: `<command> <sha>
 * [<file>…]`, run in the checkout, exits 0 green, 1 red with each non-empty
 * stdout line a failing file, any other exit no verdict. After each move of
 * `main` it adopts the new tip as the code this repo's guard hooks run, where
 * its guards load (lib/guard-code.js, #4227), and starts a levelling pass
 * over the main checkout (scripts/level-main.js, #4248), detached, since an
 * `npm ci` in it may outlast the next landing.
 *
 * It moves `main` only past its green ledger, which the
 * pre-push gate on `main` reads. A dropped member's fix ticket, and the one
 * base-red ticket for files red on `main` too, are filed in the tracker
 * .claude/workflow-core.json names, through file-issue.js.
 *
 * Does nothing where the `landing` module is off. Joins no §N3 family: it
 * gates nothing and is no hook.
 *
 * cli-args-exempt: openLanderRun parses it, through lib/cli-args.js.
 *
 * Exit codes: 0 on any exit the lander reaches, a held lock and a failed git
 * call included; 1 on a throw before the run; 2 on a command line it refuses.
 */

const { spawn } = require("node:child_process");
const { queueTester } = require("./lib/actions-tester.js");
const { baseRedFiler } = require("./lib/base-red-issue.js");
const { parseErrorText } = require("./lib/caught.js");
const { now } = require("./lib/check.js");
const { flagValue, parseOrCode } = require("./lib/cli-args.js");
const { dropTicketFiler, liveFilerDeps } = require("./lib/fix-ticket.js");
const { adoptGuardCodeAt, adoptionLine } = require("./lib/guard-code.js");
const {
	fileLedger,
	heartbeatWriter,
	landerFiles,
	landerLock,
} = require("./lib/lander-files.js");
const { startLevelling } = require("./lib/level-main.js");
const { localTester } = require("./lib/local-tester.js");
const { liveQueueDeps } = require("./lib/queue-issue.js");
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
const { scriptPath } = require("./lib/script-path.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const {
	buildModuleOffLine,
	moduleOn,
	readConfig,
} = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

/** @param {string} line */
const say = (line) => writeFd(1, `${line}\n`);

/**
 * @param {string} root
 * @returns {import("./lib/queue-lander.js").QueueTester}
 */
const configuredTester = (root) =>
	readConfig({ root, quiet: true }).landingTester === "actions"
		? queueTester({ root })
		: localTester({ root });

/**
 * The run the command line asks for: the canonical checkout and the
 * `--tester` command, where one is given. Else its exit code, its reason
 * printed: 2 on a command line it refuses, 1 outside a git checkout, 0 where
 * the `landing` module is off.
 * @param {string[]} argv
 * @returns {{root: string, tester: string|undefined} | number}
 */
function openLanderRun(argv) {
	const usage = `usage: node ${scriptPath("queue-lander.js")} run [--tester <command>]
  without --tester, the tester .claude/workflow-core.json's landingTester names
  <command> <sha> [<file>…] exits 0 green, 1 red (stdout: failing files),
  else no verdict`;
	const parsed = parseOrCode(argv, {
		usage,
		commands: { run: { usage, flags: { "--tester": "value" } } },
	});
	if (typeof parsed === "number") return parsed;
	const root = repoRoot();
	if (root === null) {
		writeFd(2, "queue-lander: not in a git checkout\n");
		return 1;
	}
	if (!moduleOn("landing", { root })) {
		say(`SKIP: ${buildModuleOffLine("landing")}`);
		return 0;
	}
	return { root, tester: flagValue(parsed.flags, "--tester") };
}

/**
 * The tester `--tester <command>` names, run in `root`, the whole suite or
 * only the files where they are given.
 * @param {string} command
 * @param {string} root
 * @returns {import("./lib/queue-lander.js").QueueTester}
 */
const commandTester = (command, root) => ({
	verdict: (sha, files = []) =>
		new Promise((resolve) => {
			const child = spawn(
				"sh",
				["-c", `${command} "$@"`, "tester", sha, ...files],
				{ cwd: root, stdio: ["ignore", "pipe", "inherit"] },
			);
			let out = "";
			child.stdout.on("data", (chunk) => {
				out += chunk;
			});
			child.on("error", (err) =>
				resolve({
					kind: "unknown",
					reason: `tester did not start: ${err.message}`,
				}),
			);
			child.on("close", (code, signal) => {
				if (code === 0) resolve({ kind: "green" });
				else if (code === 1)
					resolve({
						kind: "red",
						files: out
							.split("\n")
							.map((l) => l.trim())
							.filter(Boolean),
					});
				else
					resolve({
						kind: "unknown",
						reason: `tester ended ${signal ?? `exit ${code}`}`,
					});
			});
		}),
});

/**
 * After each move of `main`: the guard code's adoption and a levelling pass.
 * @param {string} root
 * @returns {void}
 */
function afterMainMove(root) {
	const adoption = adoptGuardCodeAt(root, { fetch: false });
	if (adoption) say(adoptionLine(adoption));
	startLevelling(root, (err) =>
		say(`levelling not started: ${parseErrorText(err)}`),
	);
}

/**
 * @param {string} root
 * @returns {import("./lib/queue-lander.js").QueueTracker}
 */
function trackerOf(root) {
	const deps = liveFilerDeps(root);
	return {
		...dropTicketFiler(deps),
		...baseRedFiler(liveQueueDeps(root)),
		stateOf: deps.stateOf,
	};
}

/** @param {string[]} [argv] @returns {Promise<number>} */
async function main(argv = process.argv.slice(2)) {
	const opened = openLanderRun(argv);
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
		log: (action) =>
			say(`${new Date(now()).toISOString()} ${buildQueueActionLine(action)}`),
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
