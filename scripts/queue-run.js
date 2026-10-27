#!/usr/bin/env node
/*
 * queue-run.js — the suite queue for a runner other than vitest (#1776). It
 * waits in `run-vitest.js --queue`'s FIFO and on its gate (lib/suite-queue.js),
 * then runs the command.
 *
 * IT JOINS NO FAMILY (§G4, §N3): it gates nothing, so it is no `check-*`, and
 * it is not a hook, so it is no `guard-*`. Exit 2 is its refusal, before
 * anything queues; exit 1 a wait the memory rung still holds at the queue's
 * timeout, which runs nothing (#2421).
 *
 * IT RUNS ONLY WHAT lib/suite-launch.js's `isQueueable` TAKES, so a vitest launch
 * is sent to `--queue` and the guards never meet a suite they cannot see. A
 * classifier that will not run fails open: the command queues.
 *
 * THE MARKER IS HELD UNTIL THE COMMAND EXITS, stamped `spawned` once it is up,
 * as run-vitest.js holds its own. A signal kills a waiter at once and is passed
 * to a running command, whose exit this one then takes.
 *
 * Each wait is a `.suite-queue-exits.jsonl` line (lib/queue-exit-log.js) of
 * kind `other`, or `seat` under `--seat`.
 *
 * `--seat` HOLDS ONE PART-SUITE SEAT FOR A DRIVER (#2918), a mutation loop
 * that runs `run-vitest.js <file> --queue` once per mutant. It waits once, as
 * a part-suite, so it never takes the whole-suite slot, then runs the driver
 * with its marker in SEAT_ENV. Each `--queue` run inside the seat's process
 * tree skips the queue and waits on the memory rung alone
 * (lib/suite-queue.js `heldSeat`). A driver the classifier reads as a suite
 * itself is refused.
 *
 * `--tsc` HOLDS THE MACHINE-WIDE TYPE-CHECK SLOT (#3163): one `tsc` at a time,
 * on its own rung (lib/tsc-slot.js). It waits in a queue directory of its own,
 * never behind a suite, and its gate counts `tsc` off `ps`, so an unwrapped
 * one holds it too. A command the classifier reads as a suite is refused.
 */

const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const { caught } = require("./lib/caught.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { logger } = require("./lib/entry-input.js");
const { hostRoot } = require("./lib/host-root.js");
const {
	queueExitLogPath,
	queueExitLogger,
} = require("./lib/queue-exit-log.js");
const idSeam = require("./lib/session-id.js");
const {
	buildHostPorts,
	buildLaunchPorts,
} = require("./lib/suite-concurrency-host.js");
const { isQueueable, suiteLaunchKind } = require("./lib/suite-launch.js");
const {
	QUEUE_SIGNALS,
	SEAT_ENV,
	queueJoin,
	queueLeave,
	queueStamps,
	queueSpawned,
	passingTurn,
	waitForGate,
} = require("./lib/suite-queue.js");
const { unwrap } = require("./lib/shell-words.js");
const {
	TSC_RUNG_MB,
	defaultTscQueueDir,
	tscDenial,
} = require("./lib/tsc-slot.js");
const { writeFd } = require("./lib/write-fd.js");

const LABEL = "queue-run.js";
const USAGE = `Usage: node ${path.join("scripts", "queue-run.js")} [--seat | --tsc] -- <command…>
Waits for a suite slot in the shared queue, then runs <command>: a node --test,
pytest or Python test file, a declared suiteRunners script, or an npm test
script that does not run run-vitest.js (#1776).
  --seat  wait once as a part-suite, then run <command>, a driver such as a
          mutation loop, whose \`run-vitest.js <file> --queue\` runs skip the
          queue and wait on the memory rung alone (#2918)
  --tsc   wait for the machine-wide type-check slot, then run <command>, a
          type-check such as \`tsc --noEmit\` (#3163)`;

/* Why lib/suite-launch.js's reading refuses the command; `queue` is absent. */
const REFUSALS = {
	queued: "the command is already a queue-run.js launch.",
	vitest:
		"the command is a vitest launch, whose queue is run-vitest.js's `--queue`.",
	none: "the command runs no suite the cap counts, so there is no slot to wait for. A host's own runner script is declared under `suiteRunners` in .claude/workflow-core.json.",
};

const SEAT_REFUSAL =
	"--seat runs a driver whose suites are `run-vitest.js <file> --queue` runs, and this command is a suite itself; queue it without --seat.";

const TSC_REFUSAL =
	"--tsc holds the type-check slot, and this command is a suite; queue it without --tsc.";

/* Why a slot refuses a command that is itself a suite. */
const SLOT_REFUSALS = { seat: SEAT_REFUSAL, tsc: TSC_REFUSAL };

/* What a `--tsc` wait prints in place of a suite's (#3163). */
const TSC_WAIT = {
	waiting: `waiting for the type-check slot: a \`tsc\` running, or MemAvailable under its ~${TSC_RUNG_MB} MB rung`,
	cap: "one `tsc` runs at a time (#3163)",
};

/**
 * The type-check slot's gate, off the guard's own `ps` and MemAvailable
 * readers (#3163); an unread one is logged and fails open.
 */
function tscGate() {
	const log = logger(LABEL);
	const ports = buildHostPorts({ root: hostRoot(), payload: {}, log });
	const rows = ports.psRows();
	const mb = ports.availableMb();
	if (rows === null) log("ps unreadable — the type-check slot read as free");
	if (mb === null) log("MemAvailable unreadable — the type-check rung unread");
	return tscDenial(rows, mb);
}

/* The weight a seat joins and asks the gate with: one test file, a part-suite
 * (#2918). */
const SEAT_WEIGHT = { resolvedFiles: 1, wholeSlot: false };

/**
 * lib/suite-launch.js's reading of the command: `queue` where this script
 * takes it, else a key of REFUSALS. A command already behind queue-run.js is
 * `queued` where its own command would queue, else that command's reading.
 * A reading that throws is `unread`, logged, and fails open (mantahostels#103
 * §6): queued, or under `--seat` seated.
 *
 * @param {string[]} words
 * @returns {string}
 */
function classify(words) {
	const log = logger(LABEL);
	try {
		return readingOf(words, buildLaunchPorts({ root: hostRoot(), log }));
	} catch (e) {
		log(`suite-launch reading threw — taken unread: ${caught(e).message}`);
		return "unread";
	}
}

/**
 * @param {string[]} words
 * @param {import("./lib/suite-launch.js").LaunchPorts} ports
 * @returns {string}
 */
function readingOf(words, ports) {
	const inner = unwrap(words, []).words;
	if (inner.length === 0) return "none";
	if (isQueueable(inner, ports)) return "queue";
	if (inner[0] === "node" && /(^|\/)queue-run\.js$/.test(inner[1] ?? "")) {
		const nested = inner[2] === "--" ? inner.slice(3) : inner.slice(2);
		const reading = readingOf(nested, ports);
		return reading === "queue" ? "queued" : reading;
	}
	const launch = suiteLaunchKind(inner, ports);
	return launch && VITEST_KINDS.includes(launch.kind) ? "vitest" : "none";
}

const VITEST_KINDS = ["npm-vitest", "npm-watch", "wrapper"];

/**
 * Why this script refuses the command, or null where it queues it.
 *
 * @param {string[]} words
 * @param {"seat" | "tsc" | null} slot
 * @returns {string | null}
 */
function refusalOf(words, slot) {
	const reading = classify(words);
	if (reading === "unread") return null;
	if (slot) return reading === "none" ? null : SLOT_REFUSALS[slot];
	if (reading === "queue") return null;
	return (
		REFUSALS[/** @type {keyof typeof REFUSALS} */ (reading)] ?? REFUSALS.none
	);
}

/**
 * @typedef {{ write: (s: string) => unknown }} Out
 * @typedef {import("./lib/suite-queue.js").QueuedLaunchOptions & {
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

/** @typedef {"seat" | "tsc" | null} Slot */

/**
 * What a slot flag changes about the wait: the queue it joins, the weight it
 * joins with, and the gate options it waits on (#2918, #3163).
 *
 * @param {Slot} slot
 * @param {Options} options
 */
function slotWait(slot, options) {
	if (slot === "seat")
		return {
			queue: options,
			join: { ...options, weight: SEAT_WEIGHT },
			gate: { gateWeight: SEAT_WEIGHT, part: true },
		};
	if (slot === "tsc") {
		/* The type-check slot's queue is a directory of its own. */
		const queue = {
			...options,
			queueDir: options.queueDir ?? defaultTscQueueDir(),
		};
		return {
			queue,
			join: queue,
			gate: { gate: options.gate ?? tscGate, ...TSC_WAIT },
		};
	}
	return { queue: options, join: options, gate: {} };
}

/**
 * The slot the flags ask for, or null for none; undefined where they ask for
 * both.
 *
 * @param {Record<string, unknown>} flags
 * @returns {Slot | undefined}
 */
function slotOf(flags) {
	const seat = flags["--seat"] === true;
	const tsc = flags["--tsc"] === true;
	if (seat && tsc) return;
	if (seat) return "seat";
	return tsc ? "tsc" : null;
}

/**
 * @param {string[]} argv
 * @param {Options} [options]
 * @returns {Promise<number>}
 */
async function main(argv, options = {}) {
	const parsed = parseOrCode(argv, {
		usage: USAGE,
		flags: { "--seat": "boolean", "--tsc": "boolean" },
		min: 1,
		max: Number.POSITIVE_INFINITY,
	});
	if (typeof parsed === "number") return parsed;
	const words = parsed.positionals;
	const slot = slotOf(parsed.flags);
	const err = options.err ?? STDERR;
	if (slot === undefined) {
		err.write(`${LABEL}: --seat and --tsc hold different slots; give one.\n`);
		return 2;
	}
	const why = refusalOf(words, slot);
	if (why) {
		err.write(`${LABEL}: not queued — ${why}\n`);
		return 2;
	}

	const logExit = queueExitLogger({
		file:
			options.queueLog === undefined
				? queueExitLogPath(hostRoot())
				: options.queueLog,
		kind: slot ?? "other",
		session:
			options.sessionId === undefined ? idSeam.fromEnv() : options.sessionId,
		label: LABEL,
		err,
	});

	const { queue, join, gate } = slotWait(slot, options);
	const ticket = queueJoin(join);
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
			queueLeave(ticket, queue);
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
		queueLeave(ticket, queue);
		exit(code);
	};
	for (const [signal, code] of Object.entries(QUEUE_SIGNALS)) {
		const name = /** @type {NodeJS.Signals} */ (signal);
		signals.on(name, () => onSignal(name, code));
	}

	const { turn, exitFields } = passingTurn(queue);
	const outcome = await waitForGate({
		turn,
		label: LABEL,
		...queue,
		...gate,
		...queueStamps(ticket, queue),
		onExit: (reason, waitMs, heldBy) => {
			waiting = false;
			logExit(reason, waitMs, exitFields(reason, heldBy));
		},
	});
	if (outcome === "refused") {
		finish(1);
		return done;
	}

	const [command = "", ...args] = words;
	const running = (options.spawnFn ?? spawn)(command, args, {
		stdio: "inherit",
		...(slot === "seat" ? { env: { ...process.env, [SEAT_ENV]: ticket } } : {}),
	});
	child = running;
	running.once("spawn", () => queueSpawned(ticket, queue));
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
