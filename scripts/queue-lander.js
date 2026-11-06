#!/usr/bin/env node
/*
 * queue-lander.js — one queue lander run: while any
 * `queue/<name>` ref waits on the remote, take them all as one batch, merge
 * them onto `main` or onto a batch still under test, test the integration
 * commit and move `main` to it on green, in queue order; on red, isolate the
 * members and drop each culprit
 * (lib/queue-lander.js), over the wiring lib/queue-lander-deps.js builds.
 *
 *   node scripts/queue-lander.js run [--tester <command>]
 *
 * The tester is the one `landingTester` in .claude/workflow-core.json names:
 * the Actions one (lib/actions-tester.js's queueTester), reading the suite
 * run a push to a `lander/batch-<k>` ref starts, or else the local one
 * (lib/local-tester.js). `--tester` swaps in a command: `<command> <sha>
 * [<file>…]`, run in the checkout, exits 0 green, 1 red with each non-empty
 * stdout line a failing file, any other exit no verdict. After each move of
 * `main` it adopts the new tip as the code this repo's guard hooks run, where
 * its guards load (lib/guard-code.js, #4227), and starts a levelling pass
 * over the main checkout (scripts/level-main.js, #4248), detached, since an
 * `npm ci` in it may outlast the next landing. Where a move changed the code
 * this run loaded, the run ends once its batches are done; then, its lock
 * released, it levels the checkout until it carries the new code, asking
 * again while another pass holds the levelling lock, and starts a fresh
 * lander (scripts/start-lander.js) on it (#4521).
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
 * call included; 1 on a throw before the run or outside a git checkout; 2 on a
 * command line it refuses.
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { setTimeout: wait } = require("node:timers/promises");
const { parseErrorText } = require("./lib/caught.js");
const { flagValue, parseOrCode } = require("./lib/cli-args.js");
const {
	isCarried,
	levelUntilCarried,
	readRunCode,
	readSupersededFiles,
} = require("./lib/lander-code.js");
const { short } = require("./lib/lander-git.js");
const { levelNow } = require("./lib/level-main.js");
const { buildLanderDeps } = require("./lib/queue-lander-deps.js");
const { runQueueLander } = require("./lib/queue-lander.js");
const { scriptPath } = require("./lib/script-path.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const {
	buildModuleOffLine,
	moduleOn,
} = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

/** @param {string} line */
const say = (line) => writeFd(1, `${line}\n`);

/**
 * The run the command line asks for: the canonical checkout and the
 * `--tester` command, where one is given. Else its exit code, its reason
 * printed.
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

/** @param {string[]} [argv] @returns {Promise<number>} */
async function main(argv = process.argv.slice(2)) {
	const opened = openLanderRun(argv);
	if (typeof opened === "number") return opened;
	const { root, tester } = opened;
	const code = readRunCode(root);
	const end = await runQueueLander(
		buildLanderDeps(root, { tester, say, code }),
	);
	if (end.relaunch !== undefined && code !== null)
		await relaunch(root, tester, code, end.relaunch);
	return 0;
}

/**
 * A fresh lander on the code `sha` carries, started as any push starts one
 * once the checkout carries each superseded file as `sha` does. Its output
 * joins this run's.
 * @param {string} root
 * @param {string|undefined} tester
 * @param {import("./lib/lander-code.js").RunCode} code
 * @param {string} sha
 */
async function relaunch(root, tester, code, sha) {
	const files = readSupersededFiles(root, code, sha);
	const settled = await levelUntilCarried({
		carried: () => isCarried(root, sha, files),
		level: () => levelNow(root),
		wait: (ms) => wait(ms),
		now: Date.now,
	});
	if (!settled.carried) {
		say(
			`no fresh lander: the checkout never carried ${short(sha)}'s code${settled.failed === null ? "" : ` (${settled.failed})`}; the next push or refill tick starts one`,
		);
		return;
	}
	const r = spawnSync(
		process.execPath,
		[
			path.join(__dirname, "start-lander.js"),
			"--launched-by",
			"the queue lander, its own code changed on main",
			...(tester === undefined ? [] : ["--tester", tester]),
		],
		{ cwd: root, stdio: "inherit" },
	);
	if (r.status !== 0)
		say(
			`the fresh lander did not start (${r.error?.message ?? `exit ${r.status}`}); the next push or refill tick starts one`,
		);
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
