#!/usr/bin/env node
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
const { writeFd } = require("./lib/write-fd.js");

/** @param {string} line */
const say = (line) => writeFd(1, `${line}\n`);

/**
 * @param {string[]} argv
 * @returns {{root: string, tester: string|undefined} | number}
 */
function openLanderRun(argv) {
	const usage = `usage: node ${scriptPath("queue-lander.js")} run [--tester <command>]
  without --tester, the tester .claude/workflow-core.json's landingTester names,
  or under auto the one the median whole run picks
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
