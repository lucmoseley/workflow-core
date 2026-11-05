/*
 * lander-cli.js — what the two lander programs, scripts/lander.js and
 * scripts/queue-lander.js, share around their runs: the command line, the
 * checkout and module checks before a run, its timestamped log, the tester a
 * `--tester <command>` names, and the step after each move of `main`.
 */

const { spawn } = require("node:child_process");
const { parseErrorText } = require("./caught.js");
const { now } = require("./check.js");
const { flagValue, parseOrCode } = require("./cli-args.js");
const { adoptGuardCodeAt, adoptionLine } = require("./guard-code.js");
const { startLevelling } = require("./level-main.js");
const { scriptPath } = require("./script-path.js");
const { repoRoot } = require("./test-pass-marker.js");
const { buildModuleOffLine, moduleOn } = require("./workflow-core-config.js");
const { writeFd } = require("./write-fd.js");

/** @param {string} line */
const say = (line) => writeFd(1, `${line}\n`);

/**
 * A log line for each action, stamped with the time it was taken.
 * @template A
 * @param {(action: A) => string} build
 * @returns {(action: A) => void}
 */
const stampedLog = (build) => (action) =>
	say(`${new Date(now()).toISOString()} ${build(action)}`);

/**
 * The run a lander program's command line asks for: the canonical checkout
 * and the `--tester` command, where one is given. Else its exit code, its
 * reason printed: 2 on a command line it refuses, 1 outside a git checkout,
 * 0 where the `landing` module is off.
 * @param {string[]} argv
 * @param {string} program its file under scripts/, as `lander.js`
 * @returns {{root: string, tester: string|undefined} | number}
 */
function openLanderRun(argv, program) {
	const usage = `usage: node ${scriptPath(program)} run [--tester <command>]
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
		writeFd(2, `${program.replace(/\.js$/, "")}: not in a git checkout\n`);
		return 1;
	}
	if (!moduleOn("landing", { root })) {
		say(`SKIP: ${buildModuleOffLine("landing")}`);
		return 0;
	}
	return { root, tester: flagValue(parsed.flags, "--tester") };
}

/**
 * The tester `--tester <command>` names: `<command> <sha> [<file>…]`, run in
 * `root`, the whole suite or only the files where they are given. Exit 0 is
 * green, exit 1 red with each non-empty stdout line a failing file, any other
 * exit no verdict.
 * @param {string} command
 * @param {string} root
 * @returns {import("./lander.js").Tester}
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
 * After each move of `main`: adopts the new tip as the code this repo's guard
 * hooks run, where its guards load (lib/guard-code.js, #4227), and starts a
 * levelling pass over the main checkout (scripts/level-main.js, #4248),
 * detached, since an `npm ci` in it may outlast the next landing.
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

module.exports = {
	afterMainMove,
	commandTester,
	openLanderRun,
	say,
	stampedLog,
};
