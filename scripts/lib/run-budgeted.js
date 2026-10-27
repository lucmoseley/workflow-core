#!/usr/bin/env node
/*
 * run-budgeted.js — runs one command in a process group of its own under a
 * time budget: a TERM to the whole group at the budget, then a KILL to it a
 * grace period later (workflow-core#2855).
 *
 * WHY NOT coreutils `timeout`. GNU's signals the group; uutils', which Ubuntu
 * ships as its coreutils from 25.10 (so every `ubuntu-latest` runner from
 * 26.04), signals only its direct child. A grandchild that traps TERM then
 * outlives the KILL and holds the caller's pipes open until it exits on its
 * own. A synchronous caller spawns this with no timeout of its own.
 *
 * The command inherits stdout and stderr; stdin is closed. Past the budget a
 * group whose leader has already exited is killed too, so no straggler holds
 * the pipes. A signal to this process kills the group and ends this process by
 * the same signal. RESIDUAL: a SIGKILL to this process (earlyoom) cannot be
 * caught, and leaves the group running.
 *
 * Usage: node scripts/lib/run-budgeted.js <budget-ms> <kill-after-ms> <command> [args…]
 * Exit: GNU `timeout`'s codes — the command's own status where it ended inside
 * the budget, and the same signal where a signal ended it; past the budget,
 * 124 where the TERM ended it and 137 where the KILL had to. 125 where this
 * runner itself failed, a usage error or a command that would not start, with
 * one stderr line opening APPARATUS_PREFIX.
 */

const { spawn } = require("node:child_process");
const { killGroup } = require("./grouped-child.js");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

const TIMEOUT_EXIT = 124;
const KILLED_EXIT = 137;
const APPARATUS_EXIT = 125;
const APPARATUS_PREFIX = "run-budgeted: ";
const FORWARDED = /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"]);

/** @param {string} why @returns {never} */
function apparatusFailed(why) {
	writeFd(2, `${APPARATUS_PREFIX}${why}\n`);
	process.exit(APPARATUS_EXIT);
}

/* End this process by `signal`. Adding and dropping a listener hands the
 * signal back its default action, which node otherwise withholds from SIGPIPE
 * (ignored) and SIGUSR1 (its inspector's). */
function dieBy(/** @type {NodeJS.Signals} */ signal) {
	process.removeAllListeners(signal);
	const noop = () => {
		/* Only its registering matters. */
	};
	process.on(signal, noop);
	process.removeListener(signal, noop);
	process.kill(process.pid, signal);
}

function main() {
	const [budgetRaw, killAfterRaw, command, ...args] = process.argv.slice(2);
	const budgetMs = Number(budgetRaw);
	const killAfterMs = Number(killAfterRaw);
	if (!command || !(budgetMs > 0) || !(killAfterMs > 0))
		apparatusFailed(
			"usage: run-budgeted.js <budget-ms> <kill-after-ms> <command> [args…]",
		);

	/** @type {"TERM"|"KILL"|null} */
	let sent = null;
	/** @type {number|undefined} */
	let pgid;
	/** @param {NodeJS.Signals} signal */
	const signalGroup = (signal) => {
		if (pgid !== undefined) killGroup(pgid, signal);
	};

	/* Armed before the spawn: the command runs, and can reach the caller,
	 * before `spawn` returns, and a signal then would meet only the default
	 * action and leave the group running (workflow-core#2928). Node runs the handler on a
	 * later tick, by which time `pgid` is set. */
	for (const signal of FORWARDED)
		process.on(signal, () => {
			signalGroup("SIGKILL");
			dieBy(signal);
		});

	const child = spawn(command, args, {
		detached: true,
		stdio: ["ignore", "inherit", "inherit"],
	});
	pgid = child.pid;

	const budget = setTimeout(() => {
		sent = "TERM";
		signalGroup("SIGTERM");
		setTimeout(() => {
			sent = "KILL";
			signalGroup("SIGKILL");
		}, killAfterMs);
	}, budgetMs);

	child.on("error", (e) =>
		apparatusFailed(`${command} would not start: ${caught(e).code ?? ""}`),
	);
	child.on("exit", (code, signal) => {
		clearTimeout(budget);
		if (sent) {
			signalGroup("SIGKILL");
			process.exit(sent === "KILL" ? KILLED_EXIT : TIMEOUT_EXIT);
		}
		if (signal) dieBy(signal);
		else process.exit(code ?? 1);
	});
}

if (require.main === module) main();

module.exports = {
	RUN_BUDGETED: __filename,
	TIMEOUT_EXIT,
	KILLED_EXIT,
	APPARATUS_EXIT,
	APPARATUS_PREFIX,
};
