#!/usr/bin/env node
/*
 * refill-panel.js — the refill loop's control panel beside an agents view (#3873,
 * spec #3596): a terminal program with no Claude process that shows the Refill
 * loop switch and its three-line block, and pauses or resumes the loop on a click.
 * What it draws is lib/refill-panel.js's; the terminal, lib/refill-panel-terminal.js's.
 *
 *   node scripts/refill-panel.js <agents-view-pid>
 *
 * Joins no §N3 family: it gates nothing and is no hook.
 *
 * It reads `refill-loop.js status --json` on a poll and after every press, and
 * writes only by running `refill-loop.js set`. It exits when the given pid is
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
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const { FETCH_TIMEOUT_MS } = require("./lib/refill-code.js");

const USAGE = `usage: node ${scriptPath("refill-panel.js")} <agents-view-pid>

Shows the refill loop and pauses or resumes it on a click, until that pid exits.
`;

const LOOP_PROGRAM = path.join(__dirname, "refill-loop.js");
/* Untraced, a first guess: past the control lock's 10 s wait (lib/pid-lock.js). */
const READ_TIMEOUT_MS = 30_000;
/* A `set --resume` with no process fetches the loop's code first (#3861); killed
 * mid-fetch, it would leave the loop unpaused with no process. */
const PRESS_TIMEOUT_MS = READ_TIMEOUT_MS + FETCH_TIMEOUT_MS;

/** @type {import("./lib/refill-panel.js").Runner} */
const runLoopCommand = (argv) =>
	new Promise((resolve) => {
		execFile(
			process.execPath,
			[LOOP_PROGRAM, ...argv],
			{ timeout: argv[0] === "status" ? READ_TIMEOUT_MS : PRESS_TIMEOUT_MS },
			(err, stdout, stderr) => {
				if (!err) {
					resolve({ code: 0, stdout, stderr });
					return;
				}
				const code = typeof err.code === "number" ? err.code : 1;
				resolve({ code, stdout, stderr: stderr || err.message });
			},
		);
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
	openPanel({
		pid,
		stdin: process.stdin,
		stdout: process.stdout,
		proc: process,
		run: runLoopCommand,
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
