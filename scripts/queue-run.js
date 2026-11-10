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
 * `--seat` HOLDS ONE PART-SUITE SEAT FOR A DRIVER (workflow-core#2918), a mutation loop
 * that runs `run-vitest.js <file> --queue` once per mutant. It waits once, as
 * a part-suite, so it never takes the whole-suite slot, then runs the driver
 * with its marker in SEAT_ENV. Each `--queue` run inside the seat's process
 * tree skips the queue and waits on the memory rung alone
 * (lib/suite-queue.js `heldSeat`). A driver the classifier reads as a suite
 * itself is refused.
 *
 * `--tsc` HOLDS THE MACHINE-WIDE TYPE-CHECK SLOT (workflow-core#3163): one `tsc` at a time,
 * on its own rung (lib/tsc-slot.js). It waits in a queue directory of its own,
 * never behind a suite, and its gate counts `tsc` off `ps`, so an unwrapped
 * one holds it too. A command the classifier reads as a suite is refused.
 * Under lib/tsc-slot.js's TSC_NO_WAIT_ENV it tries the slot once and exits
 * TSC_BUSY_EXIT, running nothing, where it is held (workflow-core#3278). Its command
 * gets its marker in TSC_SLOT_ENV, and a `--tsc` launch inside that command's
 * process tree runs at once, in the slot it already holds (workflow-core#3404).
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
	SEAT_ENV,
	heldMarker,
	queueSeat,
	queuedRunnerPeakMb,
} = require("./lib/suite-queue.js");
const { unwrapArgv } = require("./lib/shell-words.js");
const {
	TSC_BUSY_EXIT,
	TSC_NO_WAIT_ENV,
	TSC_SLOT_ENV,
	defaultTscQueueDir,
	launchPeakMb,
	tscDenial,
	tscLaunchBin,
} = require("./lib/tsc-slot.js");
const { rungMb } = require("./lib/suite-ladder.js");
const { readWindowsRecorded } = require("./lib/windows-memory.js");
const { writeFd } = require("./lib/write-fd.js");

const LABEL = "queue-run.js";
const USAGE = `Usage: node ${path.join("scripts", "queue-run.js")} [--seat | --tsc] -- <command…>
Waits for a suite slot in the shared queue, then runs <command>: a node --test,
pytest or Python test file, a declared suiteRunners script, or an npm test
script that does not run run-vitest.js (workflow-core#1776).
  --seat  wait once as a part-suite, then run <command>, a driver such as a
          mutation loop, whose \`run-vitest.js <file> --queue\` runs skip the
          queue and wait on the memory rung alone (workflow-core#2918)
  --tsc   wait for the machine-wide type-check slot, then run <command>, a
          type-check such as \`tsc --noEmit\` (workflow-core#3163)`;

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

/**
 * What a `--tsc` wait prints in place of a suite's (workflow-core#3163), on the rung of
 * the launch's own compiler (workflow-core#4892).
 * @param {number} peakMb
 */
const buildTscWait = (peakMb) => ({
	waiting: `waiting for the type-check slot: a \`tsc\` running, a suite starting (workflow-core#3203), or MemAvailable, less what a climbing suite has yet to draw (workflow-core#3416), under its ~${rungMb(peakMb)} MB rung, or Windows' own free memory under what it draws (workflow-core#4557)`,
	cap: "one `tsc` runs at a time (workflow-core#3163)",
	traceLimbs: true,
});

/**
 * The type-check slot's gate, off the guard's own `ps` and MemAvailable
 * readers (workflow-core#3163); an unread one is logged and fails open. `climbMb` is what
 * the suite queue's launches have yet to draw (workflow-core#3416); `peakMb` the launch's
 * compiler's (workflow-core#4892).
 *
 * @param {number} climbMb
 * @param {number} peakMb
 */
function tscGate(climbMb, peakMb) {
	const log = logger(LABEL);
	const ports = buildHostPorts(hostRoot(), log);
	const rows = ports.psRows();
	const mb = ports.availableMb();
	if (rows === null) log("ps unreadable — the type-check slot read as free");
	if (mb === null) log("MemAvailable unreadable — the type-check rung unread");
	const windows = readWindowsRecorded(
		ports.windowsMemory,
		log,
		"the type-check slot",
	);
	return tscDenial(rows, mb, climbMb, { windows, peakMb });
}

/* The weight a seat joins and asks the gate with: one test file, a part-suite
 * (workflow-core#2918). */
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
	const readings = unwrapArgv(words).map(({ words: inner }) =>
		runReading(inner, ports),
	);
	return READING_RANK.find((r) => readings.includes(r)) ?? "none";
}

/* The reading a command takes from its runs' readings, the first here any
 * run reads: each refusal before the launch this script takes; `none` where
 * every run reads none. */
const READING_RANK = ["vitest", "queued", "queue"];

/**
 * One unwrap run's reading, as readingOf answers.
 * @param {string[]} inner
 * @param {import("./lib/suite-launch.js").LaunchPorts} ports
 * @returns {string}
 */
function runReading(inner, ports) {
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
 * @typedef {import("./lib/suite-queue.js").QueuedLaunchOptions & Parameters<typeof heldMarker>[1] & {
 *   spawnFn?: typeof spawn,
 *   signals?: { on: (signal: NodeJS.Signals, fn: () => void) => unknown },
 *   exit?: (code: number) => void,
 *   queueLog?: string | null,
 *   sessionId?: string | null,
 *   err?: Out,
 *   tscPeakMb?: number,
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

/** @typedef {import("./lib/suite-queue.js").QueueSeat["stamps"]} Stamps */

/** @param {object} gate */
const waitOn = (gate) => () => gate;

const refusedRun = () => 1;

/* The variable a slot hands its command, naming its marker (workflow-core#2918, workflow-core#3404). */
/** @type {Record<"seat" | "tsc", string>} */
const SLOT_ENVS = { seat: SEAT_ENV, tsc: TSC_SLOT_ENV };

/**
 * A `--tsc` try's wait under TSC_NO_WAIT_ENV (workflow-core#3278): the gate's first answer
 * is final, and a rival admitted on the same poll reads as a held slot, so
 * the try refuses rather than sleep a poll.
 *
 * @param {{ gate: (climbMb: number) => import("./lib/suite-queue.js").GateDenial | null }} gate
 */
const tryOn = (gate) => (/** @type {Stamps} */ stamps) => {
	let yielded = false;
	return {
		...gate,
		timeoutMs: 0,
		out: { write: () => true },
		sleepFn: () => Promise.resolve(),
		admit: () => {
			const admission = stamps.admit();
			yielded = admission !== "admitted";
			return admission;
		},
		gate: (/** @type {number} */ climbMb) =>
			yielded ? { limb: "count" } : gate.gate(climbMb),
	};
};

/**
 * @param {Out} err
 * @returns {number}
 */
function sayTscHeld(err) {
	err.write(
		`${LABEL}: the type-check slot is held, by a \`tsc\` running, a suite starting (workflow-core#3203) or MemAvailable, less what a climbing suite has yet to draw (workflow-core#3416), under its rung — not run, as ${TSC_NO_WAIT_ENV} asks (workflow-core#3278)\n`,
	);
	return TSC_BUSY_EXIT;
}

/**
 * What a slot flag changes about the wait: the queue it joins, the weight it
 * joins with, the wait options it builds from its marker's stamps, and the
 * exit a refusal takes (workflow-core#2918, workflow-core#3163, workflow-core#3278). With no slot the marker carries
 * the command's runner peak where one is measured (workflow-core#4648).
 *
 * @param {Slot} slot
 * @param {Options} options
 * @param {string[]} words
 */
function slotWait(slot, options, words) {
	if (slot === "seat")
		return {
			queue: options,
			join: { ...options, weight: SEAT_WEIGHT },
			wait: waitOn({ gateWeight: SEAT_WEIGHT, part: true }),
			refused: refusedRun,
		};
	if (slot === "tsc") {
		/* The type-check slot's queue is a directory of its own. The launch is
		 * charged the peak of the compiler its `tsc` resolves to from here, stamped on its
		 * marker for the suite queue's climb and on its exit line for the
		 * replay (workflow-core#4892). */
		const queue = {
			...options,
			queueDir: options.queueDir ?? defaultTscQueueDir(),
		};
		const chargeMb =
			options.tscPeakMb ??
			launchPeakMb(process.cwd(), { bin: tscLaunchBin(words) ?? "tsc" });
		const gate = {
			gate:
				options.gate ??
				((/** @type {number} */ climbMb) => tscGate(climbMb, chargeMb)),
			...buildTscWait(chargeMb),
		};
		const join = { ...queue, chargeMb };
		if (process.env[TSC_NO_WAIT_ENV] === "1")
			return {
				queue,
				join,
				wait: tryOn(gate),
				refused: sayTscHeld,
				exitExtra: { noWait: true, chargeMb },
			};
		return {
			queue,
			join,
			wait: waitOn(gate),
			refused: refusedRun,
			exitExtra: { chargeMb },
		};
	}
	const charges = unwrapArgv(words).flatMap(({ words: inner }) => {
		const mb = queuedRunnerPeakMb(inner);
		return mb === undefined ? [] : [mb];
	});
	/* The heaviest run's: runs a `&` or `|` sets side by side are charged as
	 * that one alone. */
	const chargeMb = charges.length > 0 ? Math.max(...charges) : undefined;
	return {
		queue: options,
		join: chargeMb === undefined ? options : { ...options, chargeMb },
		wait: waitOn({}),
		refused: refusedRun,
	};
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
	return run(words, slot, options, err);
}

/**
 * Wait in the slot's queue, then run the command, holding the marker until it
 * exits.
 *
 * @param {string[]} words
 * @param {Slot} slot
 * @param {Options} options
 * @param {Out} err
 * @returns {Promise<number>}
 */
async function run(words, slot, options, err) {
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

	/* A `--tsc` launch inside a `--tsc` command's process tree: its slot is
	 * held already, and queueing would wait behind it forever (workflow-core#3404). */
	const held = slot === "tsc" && heldMarker(TSC_SLOT_ENV, options) !== null;
	const { queue, join, wait, refused, exitExtra } = slotWait(
		slot,
		options,
		words,
	);
	/** @type {import("node:child_process").ChildProcess | null} */
	let child = null;
	/* A killed waiter exits on the spot: its poll would otherwise run on. Once
	 * the wait has ended a signal is the command's to answer, and this process
	 * exits on the command's exit. */
	const seat = queueSeat({
		queue,
		join: held ? false : join,
		logExit: exitExtra
			? (reason, waitMs, extra) =>
					logExit(reason, waitMs, {
						...extra,
						...(reason === "killed" ? {} : exitExtra),
					})
			: logExit,
		signals: {
			...(options.signals ? { emitter: options.signals } : {}),
			...(options.exit ? { exit: options.exit } : {}),
			onSignal: (signal) => {
				child?.kill(signal);
				return true;
			},
		},
	});
	/** @type {(code: number) => void} */
	let finish = () => {
		/* replaced as `done` is built */
	};
	const done = new Promise((resolve) => {
		finish = (code) => {
			seat.leave();
			resolve(code);
		};
	});

	const outcome = held
		? null
		: await seat.wait({
				label: LABEL,
				...queue,
				...wait(seat.stamps),
			});
	if (outcome === "refused") finish(refused(err));
	else
		child = spawnCommand(words, {
			handed: held || !slot ? null : SLOT_ENVS[slot],
			seat,
			options,
			err,
			finish,
		});
	return done;
}

/**
 * Start `words`, handing the seat's ticket on in the `handed` variable, and
 * end with `finish` on its exit status: 127 where it would not start.
 *
 * @param {string[]} words
 * @param {{
 *   handed: string | null | undefined,
 *   seat: ReturnType<typeof queueSeat>,
 *   options: Options,
 *   err: Out,
 *   finish: (code: number) => void,
 * }} launch
 */
function spawnCommand(words, { handed, seat, options, err, finish }) {
	const [command = "", ...args] = words;
	const running = (options.spawnFn ?? spawn)(command, args, {
		stdio: "inherit",
		...(handed ? { env: { ...process.env, [handed]: seat.ticket } } : {}),
	});
	running.once("spawn", seat.spawned);
	running.once("error", (error) => {
		err.write(`${LABEL}: ${command} would not start — ${error.message}\n`);
		finish(127);
	});
	running.once("exit", (code, signal) => finish(exitStatus(code, signal)));
	return running;
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
