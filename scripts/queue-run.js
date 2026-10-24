#!/usr/bin/env node
/*
 * queue-run.js — the suite queue for a runner other than vitest (workflow-core#1776). It
 * waits in `run-vitest.js --queue`'s FIFO and on its gate (lib/suite-queue.js),
 * then runs the command.
 *
 * IT JOINS NO FAMILY (§G4, §N3): it gates nothing, so it is no `check-*`, and
 * it is not a hook, so it is no `guard-*`. Exit 2 is its refusal, before
 * anything queues; exit 1 a wait the memory rung still holds at the queue's
 * timeout, which runs nothing (workflow-core#2421).
 *
 * THE GUARD READS THROUGH IT. guard-suite-concurrency.sh judges the command it
 * is handed, and a waiter script hides the suite it runs (mantahostels#2024),
 * so lib/suite-launch.sh reads `node <path>/queue-run.js -- <command>` as that
 * command, queued, and the count-cap deny lets it past as it lets `--queue`.
 *
 * IT RUNS ONLY WHAT lib/suite-launch.sh's `queueable` TAKES, so a vitest launch
 * is sent to `--queue` and the guards never meet a suite they cannot see. A
 * classifier that will not run fails open: the command queues.
 *
 * THE MARKER IS HELD UNTIL THE COMMAND EXITS, stamped `spawned` once it is up,
 * as run-vitest.js holds its own. A signal kills a waiter at once and is passed
 * to a running command, whose exit this one then takes. A command started with
 * no wrapper ahead of it holds the slot as soon as it spawns; one behind
 * `timeout` is counted once `timeout` execs it.
 *
 * Each wait is a `.suite-queue-exits.jsonl` line (lib/queue-exit-log.js) of
 * kind `other`.
 */

const { spawn, spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const { parseOrCode } = require("./lib/cli-args.js");
const { hostRoot } = require("./lib/host-root.js");
const {
	queueExitLogPath,
	queueExitLogger,
} = require("./lib/queue-exit-log.js");
const idSeam = require("./lib/session-id.js");
const {
	QUEUE_SIGNALS,
	queueAdmit,
	queueJoin,
	queueLeave,
	queueSpawned,
	queueTurn,
	waitForGate,
} = require("./lib/suite-queue.js");
const { writeFd } = require("./lib/write-fd.js");

const LABEL = "queue-run.js";
const USAGE = `Usage: node ${path.join("scripts", "queue-run.js")} -- <command…>
Waits for a suite slot in the shared queue, then runs <command>: a node --test,
pytest or Python test file, a declared suiteRunners script, or an npm test
script that does not run run-vitest.js (workflow-core#1776).`;

/* Why lib/suite-launch.sh's reading refuses the command; `queue` is absent. */
const REFUSALS = {
	queued: "the command is already a queue-run.js launch.",
	vitest:
		"the command is a vitest launch, whose queue is run-vitest.js's `--queue`.",
	none: "the command runs no suite the cap counts, so there is no slot to wait for. A host's own runner script is declared under `suiteRunners` in .claude/workflow-core.json.",
};

/**
 * lib/suite-launch.sh's reading of the command: `queue` where this script
 * takes it, else a key of REFUSALS.
 *
 * @param {string[]} words
 * @returns {string}
 */
function classify(words) {
	const r = spawnSync(
		"bash",
		[
			"-c",
			`source "$1/guard-parse.sh" && source "$1/suite-launch.sh" || exit 3
shift
gp_unwrap "$@"
set -- \${_gp_unwrapped[@]+"\${_gp_unwrapped[@]}"}
if (($#)) && queueable "$@"; then echo queue
elif ((_sl_queued)); then echo queued
elif [[ "$_sl_kind" == npm-vitest || "$_sl_kind" == npm-watch || "$_sl_kind" == wrapper ]]; then echo vitest
else echo none
fi`,
			LABEL,
			path.join(__dirname, "lib"),
			...words,
		],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	);
	if (r.error || r.status !== 0) return "queue";
	return String(r.stdout).trim() || "queue";
}

/**
 * @typedef {{ write: (s: string) => unknown }} Out
 * @typedef {Parameters<typeof waitForGate>[0] & Parameters<typeof queueJoin>[0] & Parameters<typeof queueTurn>[0] & {
 *   spawnFn?: typeof spawn,
 *   signals?: { on: (signal: NodeJS.Signals, fn: () => void) => unknown },
 *   exit?: (code: number) => void,
 *   queueLog?: string | null,
 *   sessionId?: string | null,
 *   err?: Out,
 * }} Options
 */

/** @type {Out} */
const STDERR = { write: (s) => writeFd(2, s) };

/**
 * A child's exit status as a shell reports it: its code, or 128 + its
 * signal's number.
 *
 * @param {number|null} code
 * @param {NodeJS.Signals|null} signal
 * @returns {number}
 */
function exitStatus(code, signal) {
	if (code !== null) return code;
	const number = signal ? os.constants.signals[signal] : undefined;
	return number ? 128 + number : 1;
}

/**
 * @param {string[]} argv
 * @param {Options} [options]
 * @returns {Promise<number>}
 */
async function main(argv, options = {}) {
	const parsed = parseOrCode(argv, {
		usage: USAGE,
		min: 1,
		max: Number.POSITIVE_INFINITY,
	});
	if (typeof parsed === "number") return parsed;
	const words = parsed.positionals;
	const err = options.err ?? STDERR;
	const reading = classify(words);
	if (reading !== "queue") {
		const why =
			REFUSALS[/** @type {keyof typeof REFUSALS} */ (reading)] ?? REFUSALS.none;
		err.write(`${LABEL}: not queued — ${why}\n`);
		return 2;
	}

	const logExit = queueExitLogger({
		file:
			options.queueLog === undefined
				? queueExitLogPath(hostRoot())
				: options.queueLog,
		kind: "other",
		session:
			options.sessionId === undefined ? idSeam.fromEnv() : options.sessionId,
		label: LABEL,
		err,
	});

	const ticket = queueJoin(options);
	const started = Date.now();
	/** @type {import("node:child_process").ChildProcess | null} */
	let child = null;
	let waiting = true;
	/** @type {(code: number) => void} */
	let finish = () => {
		/* replaced as `done` is built */
	};
	const done = new Promise((resolve) => {
		finish = (code) => {
			queueLeave(ticket, options);
			resolve(code);
		};
	});

	/* A killed waiter exits on the spot: its poll would otherwise run on. */
	const signals = options.signals ?? process;
	const exit = options.exit ?? process.exit;
	/** @param {NodeJS.Signals} signal @param {number} code */
	const onSignal = (signal, code) => {
		if (child) {
			child.kill(signal);
			return;
		}
		if (!waiting) return;
		waiting = false;
		logExit("killed", Date.now() - started, { signal });
		queueLeave(ticket, options);
		exit(code);
	};
	for (const [signal, code] of Object.entries(QUEUE_SIGNALS)) {
		const name = /** @type {NodeJS.Signals} */ (signal);
		signals.on(name, () => onSignal(name, code));
	}

	const outcome = await waitForGate({
		turn: () => queueTurn(options),
		admit: () => queueAdmit(ticket, options),
		label: LABEL,
		...options,
		onExit: (reason, waitMs) => {
			waiting = false;
			logExit(reason, waitMs);
		},
	});
	if (outcome === "refused") {
		finish(1);
		return done;
	}

	const [command = "", ...args] = words;
	const running = (options.spawnFn ?? spawn)(command, args, {
		stdio: "inherit",
	});
	child = running;
	running.once("spawn", () => queueSpawned(ticket, options));
	running.once("error", (error) => {
		err.write(`${LABEL}: ${command} would not start — ${error.message}\n`);
		finish(127);
	});
	running.once("exit", (code, signal) => finish(exitStatus(code, signal)));
	return done;
}

if (require.main === module)
	main(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			process.stderr.write(`${LABEL} crashed: ${error}\n`);
			process.exitCode = 1;
		});

module.exports = { main };
