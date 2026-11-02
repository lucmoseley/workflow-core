#!/usr/bin/env node
/*
 * refill-panel.js — the refill loop's control panel beside an agents view (#3873,
 * #3877, #3879, #3881, spec #3596): a terminal program with no Claude process that shows the Refill
 * loop switch and its three-line block, and pauses or resumes the loop on a click;
 * the Away switch, which sets the loop's mode on a click; the Burn mode switch,
 * which flips burn mode on a click; and a tick box per checkout, which sets whether
 * the loop serves it.
 * What it draws is lib/refill-panel.js's; the terminal, lib/refill-panel-terminal.js's.
 *
 *   node scripts/refill-panel.js <agents-view-pid>
 *
 * Joins no §N3 family: it gates nothing and is no hook.
 *
 * It reads `refill-loop.js status --json` on a poll and after every press, and
 * writes only by running `refill-loop.js set` and `burn-mode.sh`. It exits when the given pid is
 * gone, and on Ctrl+C. A SIGKILL runs no code, so it leaves the terminal to the
 * pane closing with the process.
 *
 * Exit codes: 0 on either exit or a pid already gone; 1 with no terminal, or on a
 * crash; 2 on a command line it refuses; 128 plus a catchable signal's number.
 */

const { execFile } = require("node:child_process");
const path = require("node:path");
const { pidAlive } = require("./lib/arbiter-proc.js");
const { parseOrCode } = require("./lib/cli-args");
const { openPanel } = require("./lib/refill-panel-terminal.js");
const { readViewEnv } = require("./lib/refill-panel-view-env.js");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const { FETCH_TIMEOUT_MS } = require("./lib/refill-code.js");

const USAGE = `usage: node ${scriptPath("refill-panel.js")} <agents-view-pid>

Shows the refill loop, away mode, burn mode and the repos it can serve, and changes each on a click, until that pid exits.
`;

const LOOP_PROGRAM = path.join(__dirname, "refill-loop.js");
const BURN_PROGRAM = path.join(__dirname, "burn-mode.sh");
/* Untraced, a first guess: past the control lock's 10 s wait (lib/pid-lock.js),
 * and far past burn-mode.sh's few short writes, whose timeout reads as a failed flip. */
const READ_TIMEOUT_MS = 30_000;
/* A `set --resume` with no process fetches the loop's code first (#3861); killed
 * mid-fetch, it would leave the loop unpaused with no process. */
const PRESS_TIMEOUT_MS = READ_TIMEOUT_MS + FETCH_TIMEOUT_MS;

/**
 * @param {string} file
 * @param {string[]} argv
 * @param {number} timeout
 * @param {NodeJS.ProcessEnv} env
 * @returns {ReturnType<import("./lib/refill-panel.js").Runner>}
 */
const runCommand = (file, argv, timeout, env) =>
	new Promise((resolve) => {
		execFile(file, argv, { timeout, env }, (err, stdout, stderr) => {
			if (!err) {
				resolve({ code: 0, stdout, stderr });
				return;
			}
			const code = typeof err.code === "number" ? err.code : 1;
			resolve({ code, stdout, stderr: stderr || err.message });
		});
	});

/** @param {unknown} err */
const reportCrash = (err) =>
	writeFd(
		2,
		`refill-panel: ${err instanceof Error ? (err.stack ?? err.message) : err}\n`,
	);

/** @param {string[]} [argv] */
function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, { usage: USAGE, min: 1 });
	if (typeof parsed === "number") return parsed;
	const [given = ""] = parsed.positionals;
	if (!/^[1-9]\d*$/.test(given)) {
		writeFd(2, `refill-panel: not a pid: ${given}\n${USAGE}`);
		return 2;
	}
	const pid = Number(given);
	if (!pidAlive(pid)) return 0;
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		writeFd(2, "refill-panel: needs a terminal\n");
		return 1;
	}
	const env = { ...process.env, ...readViewEnv(pid) };
	openPanel({
		pid,
		stdin: process.stdin,
		stdout: process.stdout,
		proc: process,
		run: (args) =>
			runCommand(
				process.execPath,
				[LOOP_PROGRAM, ...args],
				args[0] === "status" ? READ_TIMEOUT_MS : PRESS_TIMEOUT_MS,
				env,
			),
		runBurn: (args) => runCommand(BURN_PROGRAM, args, READ_TIMEOUT_MS, env),
		isAlive: pidAlive,
		now: Date.now,
		reportCrash,
	});
	return null;
}

module.exports = { main };

if (require.main === module) {
	const code = main();
	if (code !== null) process.exitCode = code;
}
