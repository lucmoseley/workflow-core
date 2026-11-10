#!/usr/bin/env node
/*
 * run-budgeted.js — runs one command in a process group of its own under a
 * time budget: a TERM to the whole group at the budget, then a KILL to it a
 * grace period later (#2855).
 *
 * WHY NOT coreutils `timeout`. GNU's signals the group; uutils', which Ubuntu
 * ships as its coreutils from 25.10 (so every `ubuntu-latest` runner from
 * 26.04), signals only its direct child. A grandchild that traps TERM then
 * outlives the KILL and holds the caller's pipes open until it exits on its
 * own. A synchronous caller spawns this with no timeout of its own.
 *
 * The command inherits stdout and stderr; stdin is closed, bar --hook's. Past the budget a
 * group whose leader has already exited is killed too, so no straggler holds
 * the pipes. A signal to this process kills the group and ends this process by
 * the same signal. RESIDUAL: a SIGKILL to this process (earlyoom) cannot be
 * caught, and leaves the group running.
 *
 * Usage: node scripts/lib/run-budgeted.js <budget-ms> <kill-after-ms> <command> [args…]
 *        node scripts/lib/run-budgeted.js --hook <hook> <command> [args…]
 *
 * --hook is a git hook's checker run (#4187), through scripts/lib/hook-bound.sh:
 * the budget is HOOK_LIMIT_MS, or WFC_HOOK_LIMIT_S seconds where that is set,
 * stdin is inherited, as pre-push hands its refs on it, and a budget kill
 * writes one line naming the hook, the checker and the limit to
 * HOOK_STDERR_FD, else to stderr.
 * Exit: GNU `timeout`'s codes — the command's own status where it ended inside
 * the budget, and the same signal where a signal ended it; past the budget,
 * 124 where the TERM ended it and 137 where the KILL had to. 125 where this
 * runner itself failed, a usage error or a command that would not start, with
 * one stderr line opening APPARATUS_PREFIX.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { killGroup } = require("./grouped-child.js");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

/* `docker stop`'s default on Linux, the one published figure for this wait; no
 * run here measured what a gate's cleanup needs. */
const HOOK_GRACE_MS = 10_000;
const TIMEOUT_EXIT = 124;
const KILLED_EXIT = 137;
const APPARATUS_EXIT = 125;
const APPARATUS_PREFIX = "run-budgeted: ";
const FORWARDED = /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"]);

/* A hook checker's limit: HOOK_LIMIT_FACTOR times the slowest bounded hook
 * run measured, HOOK_SLOWEST_MS. Measured 2026-11-04 on this repo's 8-core
 * ARM64 WSL2 machine at load average 12-15 (#4187 close comment): post-commit's
 * report-new-shared-faults.js took 24.8 s; the slowest of the 30 calls a
 * pre-commit made, check-context-budget.js, 6.6 s. The factor is UNTRACED:
 * headroom for a slower adopter machine or a heavier load. Re-measure where a
 * hook gains a run of whole-repo checkers. */
const HOOK_SLOWEST_MS = 25_000;
const HOOK_LIMIT_FACTOR = 6;
const HOOK_LIMIT_MS = HOOK_SLOWEST_MS * HOOK_LIMIT_FACTOR;
const SCRIPT = /\.(?:[cm]?js|sh)$/;
/* The hook's own stderr, kept by scripts/lib/hook-bound.sh. */
const HOOK_STDERR_FD = 8;

function hookStderr() {
	try {
		fs.fstatSync(HOOK_STDERR_FD);
		return HOOK_STDERR_FD;
	} catch {
		return 2;
	}
}

/** @param {string} why */
function sayApparatus(why) {
	writeFd(2, `${APPARATUS_PREFIX}${why}\n`);
}

/** @param {string} why @returns {never} */
function apparatusFailed(why) {
	sayApparatus(why);
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

/**
 * The checker a hook's command runs: its first script argument, else the
 * command itself.
 * @param {string} command
 * @param {string[]} args
 */
function checkerOf(command, args) {
	const script = args.find((a) => SCRIPT.test(a));
	return script ? script.replace(/^\.\//, "") : command;
}

/**
 * The run `argv` asks for, the hook form's defaults filled in.
 * @param {string[]} argv
 */
function parseRun(argv) {
	if (argv[0] === "--hook") {
		const [, hook, command, ...args] = argv;
		const limitS = process.env.WFC_HOOK_LIMIT_S;
		return {
			hook,
			budgetMs: limitS ? Number(limitS) * 1000 : HOOK_LIMIT_MS,
			killAfterMs: HOOK_GRACE_MS,
			command,
			args,
		};
	}
	const [budgetRaw, killAfterRaw, command, ...args] = argv;
	return {
		hook: undefined,
		budgetMs: Number(budgetRaw),
		killAfterMs: Number(killAfterRaw),
		command,
		args,
	};
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} the code to exit with, where no signal ends this
 *   process first
 */
async function main(argv) {
	const { hook, budgetMs, killAfterMs, command, args } = parseRun(argv);
	if (!command || !(budgetMs > 0) || !(killAfterMs > 0))
		apparatusFailed(
			"usage: run-budgeted.js <budget-ms> <kill-after-ms> <command> [args…] | --hook <hook> <command> [args…], WFC_HOOK_LIMIT_S a positive number where set",
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
	 * action and leave the group running (#2928). Node runs the handler on a
	 * later tick, by which time `pgid` is set. */
	for (const signal of FORWARDED)
		process.on(signal, () => {
			signalGroup("SIGKILL");
			dieBy(signal);
		});

	const child = spawn(command, args, {
		detached: true,
		stdio: [hook ? "inherit" : "ignore", "inherit", "inherit"],
	});
	pgid = child.pid;

	const budget = setTimeout(() => {
		sent = "TERM";
		if (hook)
			writeFd(
				hookStderr(),
				`${hook}: ${checkerOf(command, args)} ran past its ${budgetMs / 1000} s limit, so it and every process it started are killed (#4187).\n`,
			);
		signalGroup("SIGTERM");
		setTimeout(() => {
			sent = "KILL";
			signalGroup("SIGKILL");
		}, killAfterMs);
	}, budgetMs);

	return new Promise((resolve) => {
		child.on("error", (e) => {
			clearTimeout(budget);
			sayApparatus(`${command} would not start: ${caught(e).code ?? ""}`);
			resolve(APPARATUS_EXIT);
		});
		child.on("exit", (code, signal) => {
			clearTimeout(budget);
			if (sent) {
				signalGroup("SIGKILL");
				resolve(sent === "KILL" ? KILLED_EXIT : TIMEOUT_EXIT);
			} else if (signal) dieBy(signal);
			else resolve(code ?? 1);
		});
	});
}

/**
 * Whether a finished run's 125 is this runner's own failure rather than the
 * command's exit, which it passes through unchanged.
 * @param {{ status: number | null, stderr: string | null }} r
 */
function isRunnerFailure(r) {
	return (
		r.status === APPARATUS_EXIT &&
		(r.stderr ?? "").trimStart().startsWith(APPARATUS_PREFIX)
	);
}

if (require.main === module)
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		/* A throw `spawn` makes itself, before any child exists. */
		(e) => apparatusFailed(caught(e).message),
	);

module.exports = {
	main,
	RUN_BUDGETED: __filename,
	TIMEOUT_EXIT,
	KILLED_EXIT,
	APPARATUS_EXIT,
	APPARATUS_PREFIX,
	isRunnerFailure,
};
