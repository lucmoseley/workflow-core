#!/usr/bin/env node
/*
 * run-grouped.js — runs one command in a process group of its own, and kills
 * that whole group when this process is told to stop (#2665).
 *
 * WHY. `execFileSync`'s timeout kills only the process it spawned. The union
 * oracle, `claude-agents-union`, is a bash wrapper that backgrounds one
 * `claude agents --json` per seat, so a timed-out read left them running
 * as orphans (#2662). Node's synchronous spawns cannot start a
 * process group, so a synchronous caller spawns this instead, under its own
 * timeout: the SIGTERM that timeout sends is passed to the group as SIGKILL.
 *
 * The command inherits this process's stdout; stdin and the command's stderr are closed. This
 * process's own stderr carries one thing: the spawn error's code (ENOENT,
 * EACCES), where the command would not start.
 *
 * RESIDUAL: a SIGKILL to this process (earlyoom) cannot be caught, and leaves
 * the group running as before.
 *
 * Usage: node scripts/lib/run-grouped.js <command> [args…]
 * Exit: the command's own status, 128 + the signal number where a signal
 * ended it, 127 where it would not start.
 */

const { spawn } = require("node:child_process");
const os = require("node:os");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

const [command, ...args] = process.argv.slice(2);
if (!command) {
	writeFd(2, "usage: run-grouped.js <command> [args…]\n");
	process.exit(2);
}

/** @type {import("node:child_process").ChildProcess|null} */
let child = null;

/** @param {"SIGTERM"|"SIGINT"|"SIGHUP"} signal */
function stopGroup(signal) {
	if (child?.pid)
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			/* The group has already gone. */
		}
	process.exit(128 + os.constants.signals[signal]);
}

for (const signal of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"]))
	process.on(signal, () => stopGroup(signal));

child = spawn(command, args, {
	detached: true,
	stdio: ["ignore", "inherit", "ignore"],
});
child.on("error", (e) => {
	writeFd(2, caught(e).code ?? "");
	process.exit(127);
});
child.on("exit", (code, signal) =>
	process.exit(signal ? 128 + os.constants.signals[signal] : (code ?? 1)),
);
