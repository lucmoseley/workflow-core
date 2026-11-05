/*
 * lander-cli.js — what the two lander programs, scripts/lander.js and
 * scripts/queue-lander.js, share around their runs: the tester a
 * `--tester <command>` names, and the step after each move of `main`.
 *
 * A production adapter (code-standards §T7): it spawns the command, and the
 * step adopts guard code and starts a levelling pass.
 */

const { spawn } = require("node:child_process");
const { parseErrorText } = require("./caught.js");
const { adoptGuardCodeAt, adoptionLine } = require("./guard-code.js");
const { startLevelling } = require("./level-main.js");

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
 * @param {(line: string) => void} say
 * @returns {void}
 */
function afterMainMove(root, say) {
	const adoption = adoptGuardCodeAt(root, { fetch: false });
	if (adoption) say(adoptionLine(adoption));
	startLevelling(root, (err) =>
		say(`levelling not started: ${parseErrorText(err)}`),
	);
}

module.exports = { afterMainMove, commandTester };
