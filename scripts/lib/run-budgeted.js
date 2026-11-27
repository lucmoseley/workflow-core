#!/usr/bin/env node

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { killGroup } = require("./grouped-child.js");
const { splitRunArgv } = require("./run-budgeted-argv.js");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");
const { noop } = require("./noop.js");

// guess, workflow-core#3923
const HOOK_GRACE_MS = 10_000;
const TIMEOUT_EXIT = 124;
const KILLED_EXIT = 137;
const APPARATUS_EXIT = 125;
const APPARATUS_PREFIX = "run-budgeted: ";
const FORWARDED = /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"]);

// measured 26.6-31.9 s at load 12-15, workflow-core#5213
const HOOK_SLOWEST_MS = 32_000;
// guess, workflow-core#5213
const HOOK_LIMIT_FACTOR = 6;
const HOOK_LIMIT_MS = HOOK_SLOWEST_MS * HOOK_LIMIT_FACTOR;
const SCRIPT = /\.(?:[cm]?js|sh)$/;
const HOOK_STDERR_FD = 8;
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

function dieBy(/** @type {NodeJS.Signals} */ signal) {
	process.removeAllListeners(signal);
	process.on(signal, noop);
	process.removeListener(signal, noop);
	process.kill(process.pid, signal);
}

/** @param {string} command @param {string[]} args */
function checkerOf(command, args) {
	const script = args.find((a) => SCRIPT.test(a));
	return script ? script.replace(/^\.\//, "") : command;
}

/** @param {string[]} argv */
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

/** @param {string[]} argv @returns {Promise<number>} */
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
				`${hook}: ${checkerOf(command, args)} ran past its ${budgetMs / 1000} s limit, so it and every process it started are killed (workflow-core#4187).\n`,
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
	const pausePipe = child.stdio[PAUSE_FD];
	pausePipe?.on("error", noop);
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

/** @param {NodeJS.ProcessEnv} env */
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
					? `${APPARATUS_PREFIX}the hook limit's clock would not pause (${code}), so this stretch runs on it (workflow-core#5213).\n`
					: `${APPARATUS_PREFIX}the hook limit's clock would not resume (${code}), so the rest of this run is unbounded (workflow-core#5213).\n`,
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

/** @param {{ status: number | null, stderr: string | null }} r */
function isRunnerFailure(r) {
	return (
		r.status === APPARATUS_EXIT &&
		(r.stderr ?? "").trimStart().startsWith(APPARATUS_PREFIX)
	);
}

if (require.main === module)
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
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
