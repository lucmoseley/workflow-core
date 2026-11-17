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
 * the pipes. A SIGTERM, SIGINT or SIGHUP to this process goes on to the group,
 * as GNU `timeout` passes on a signal it receives, so a member's own cleanup
 * runs; the group is KILLed once its leader exits, kill-after-ms after the
 * signal, or on a second signal, and this process ends by the first (#5188).
 * RESIDUAL: a SIGKILL to this process (earlyoom) cannot be
 * caught, and leaves the group running, as does a SIGKILL inside the
 * kill-after-ms grace a forwarded signal starts, to a group that ignores
 * that signal; a member still cleaning up at kill-after-ms is KILLed, its
 * cleanup unfinished.
 *
 * Usage: node scripts/lib/run-budgeted.js <budget-ms> <kill-after-ms> <command> [args…]
 *        node scripts/lib/run-budgeted.js --hook <hook> [--pausable] <command> [args…]
 *
 * --hook is a git hook's checker run (#4187), through scripts/lib/hook-bound.sh:
 * the budget is HOOK_LIMIT_MS, or WFC_HOOK_LIMIT_S seconds where that is set,
 * stdin is inherited, as pre-push hands its refs on it, and a budget kill
 * writes one line naming the hook, the checker and the limit to
 * HOOK_STDERR_FD, else to stderr. --pausable gives the command a pause pipe,
 * which takeHookPause reads, to stop the clock over a stretch the limit does
 * not own (#5213).
 * Exit: GNU `timeout`'s codes — the command's own status where it ended inside
 * the budget, and the same signal where a signal ended it; past the budget,
 * 124 where the TERM ended it and 137 where the KILL had to. 125 where this
 * runner itself failed, a usage error or a command that would not start, with
 * one stderr line opening APPARATUS_PREFIX.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { killGroup } = require("./grouped-child.js");
const { splitRunArgv } = require("./run-budgeted-argv.js");
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
 * run measured, HOOK_SLOWEST_MS. Measured 2026-11-15 on this repo's 8-core
 * ARM64 WSL2 machine at load average 12-15 (#5213): post-commit's one bounded
 * run, scripts/post-commit-dispatch.js under scripts/lib/hook-bound.sh, took
 * 26.6-31.9 s over four runs. Pre-commit's scripts/precommit-dispatch.js
 * took 21.8-22.8 s at load 2 (#5171), and prepare-commit-msg's bounded steps
 * are unmeasured: either may be the slowest at load 12-15, so HOOK_SLOWEST_MS
 * is partly a guess until they are measured there. The factor is UNTRACED: headroom for a
 * slower adopter machine or a heavier load. Re-measure where a hook gains a
 * run of whole-repo checkers. */
const HOOK_SLOWEST_MS = 32_000;
const HOOK_LIMIT_FACTOR = 6;
const HOOK_LIMIT_MS = HOOK_SLOWEST_MS * HOOK_LIMIT_FACTOR;
const SCRIPT = /\.(?:[cm]?js|sh)$/;
/* The hook's own stderr, kept by scripts/lib/hook-bound.sh. */
const HOOK_STDERR_FD = 8;
/* A --pausable command's pipe back to this runner, at PAUSE_FD and named in
 * its environment by PAUSE_FD_ENV: a PAUSE byte stops the limit's clock and
 * a RESUME byte restarts it on what was left (#5213). */
const PAUSE_FD = 3;
const PAUSE_FD_ENV = "WFC_HOOK_PAUSE_FD";
const PAUSE = "p";
const RESUME = "r";

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
	const { budgetRaw, killAfterRaw, ...run } = splitRunArgv(argv);
	if (run.hook === undefined)
		return {
			...run,
			budgetMs: Number(budgetRaw),
			killAfterMs: Number(killAfterRaw),
		};
	const limitS = process.env.WFC_HOOK_LIMIT_S;
	return {
		...run,
		budgetMs: limitS ? Number(limitS) * 1000 : HOOK_LIMIT_MS,
		killAfterMs: HOOK_GRACE_MS,
	};
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} the code to exit with, where no signal ends this
 *   process first
 */
async function main(argv) {
	const { hook, pausable, budgetMs, killAfterMs, command, args } =
		parseRun(argv);
	if (!command || !(budgetMs > 0) || !(killAfterMs > 0))
		apparatusFailed(
			"usage: run-budgeted.js <budget-ms> <kill-after-ms> <command> [args…] | --hook <hook> [--pausable] <command> [args…], WFC_HOOK_LIMIT_S a positive number where set",
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
	/** @type {NodeJS.Signals | null} */
	let stopping = null;
	/** @param {NodeJS.Signals} signal */
	const stop = (signal) => {
		if (stopping) {
			signalGroup("SIGKILL");
			dieBy(stopping);
			return;
		}
		stopping = signal;
		signalGroup(signal);
		setTimeout(() => stop(signal), killAfterMs);
	};
	for (const signal of FORWARDED) process.on(signal, stop);

	const child = spawn(command, args, {
		detached: true,
		stdio: [
			hook ? "inherit" : "ignore",
			"inherit",
			"inherit",
			...(pausable ? /** @type {const} */ (["pipe"]) : []),
		],
		...(pausable && {
			env: { ...process.env, [PAUSE_FD_ENV]: String(PAUSE_FD) },
		}),
	});
	pgid = child.pid;

	const expire = () => {
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
	};
	/** @type {NodeJS.Timeout | undefined} */
	let budget = setTimeout(expire, budgetMs);
	let left = budgetMs;
	let since = performance.now();
	/* RESIDUAL: a PAUSE is read on this loop's next turn, so a budget that
	 * runs out between the command's write and that read still kills it. */
	const pausePipe = child.stdio[PAUSE_FD];
	pausePipe?.on("error", () => {
		/* The pipe failing is the command's end, which "exit" reports (#5213). */
	});
	pausePipe?.on("data", (/** @type {Buffer} */ bytes) => {
		for (const byte of bytes.toString("latin1")) {
			if (byte === PAUSE && budget && !sent) {
				clearTimeout(budget);
				budget = undefined;
				left -= performance.now() - since;
			} else if (byte === RESUME && !budget && !sent) {
				since = performance.now();
				budget = setTimeout(expire, Math.max(left, 0));
			}
		}
	});

	return new Promise((resolve) => {
		child.on("error", (e) => {
			clearTimeout(budget);
			sayApparatus(`${command} would not start: ${caught(e).code ?? ""}`);
			resolve(APPARATUS_EXIT);
		});
		child.on("exit", (code, signal) => {
			clearTimeout(budget);
			if (stopping) {
				signalGroup("SIGKILL");
				dieBy(stopping);
			} else if (sent) {
				signalGroup("SIGKILL");
				resolve(sent === "KILL" ? KILLED_EXIT : TIMEOUT_EXIT);
			} else if (signal) dieBy(signal);
			else resolve(code ?? 1);
		});
	});
}

/**
 * The pause pipe a --pausable run named in `env`, taken out of it: `env`
 * without the name, for every child this process starts, so none reaches the
 * clock; and `outside`, which runs its argument with the clock stopped.
 * Under no such run, `outside` runs it on the clock, as it does where the
 * pipe will not take the PAUSE, saying so on stderr (#5213).
 * @param {NodeJS.ProcessEnv} env
 */
function takeHookPause(env) {
	const { [PAUSE_FD_ENV]: named, ...rest } = env;
	const piped = named === String(PAUSE_FD);
	/** @param {string} byte */
	const send = (byte) => {
		try {
			fs.writeSync(PAUSE_FD, byte);
			return true;
		} catch (e) {
			const code = caught(e).code ?? "unknown";
			writeFd(
				2,
				byte === PAUSE
					? `${APPARATUS_PREFIX}the hook limit's clock would not pause (${code}), so this stretch runs on it (#5213).\n`
					: `${APPARATUS_PREFIX}the hook limit's clock would not resume (${code}), so the rest of this run is unbounded (#5213).\n`,
			);
			return false;
		}
	};
	return {
		env: rest,
		/**
		 * @template T
		 * @param {() => T} run
		 * @returns {T}
		 */
		outside(run) {
			if (!piped || !send(PAUSE)) return run();
			try {
				return run();
			} finally {
				send(RESUME);
			}
		},
	};
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
	HOOK_GRACE_MS,
	main,
	RUN_BUDGETED: __filename,
	TIMEOUT_EXIT,
	KILLED_EXIT,
	APPARATUS_EXIT,
	APPARATUS_PREFIX,
	isRunnerFailure,
	takeHookPause,
};
