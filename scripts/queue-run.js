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
 * its slot's kind, `seat`, `tsc` or `gate`, or `other` with no slot flag.
 *
 * A COMMAND NAMING ITS TEST FILES WAITS AS A PART-SUITE (workflow-core#5274, spec workflow-core#5273
 * §7), as the guard counts it: it never takes or waits for the whole-suite
 * slot, and the memory rung still charges it a whole suite's workers.
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
 *
 * `--gate` HOLDS A GATE SEAT FOR A COMMIT GATE (workflow-core#5274, spec workflow-core#5273 §1): a
 * repo's declared test command run for one commit's verdict, taken by its
 * role and never read by the classifier: its words, joined, run through
 * `sh -c`, their stderr folded into stdout, the one stream both commit
 * launch points read. It waits in the suite queue's FIFO
 * for the whole-suite slot, priced whole on the memory rung, and is never
 * refused at the queue's wait bound, so a commit keeps its place. Waiting, it
 * prints its position, the slot's holder and the time waited on joining and
 * at each change. Its command runs in a process group of its own under the
 * suite ceiling, killed and red past it, with its marker in GATE_ENV, and
 * each run is a `.gate-runs.jsonl` line carrying its tree's PSS peak
 * (lib/gate-seat.js). A `--seat` or plain launch inside a gate seat's process
 * tree runs at once, in the slot the seat holds; a gate inside a running
 * suite's tree runs at once, in that suite's.
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
const {
	hasNamedTestFiles,
	isQueueable,
	suiteLaunchKind,
} = require("./lib/suite-launch.js");
const {
	SEAT_ENV,
	heldMarker,
	queueSeat,
	queuedRunnerPeakMb,
	readSlotPlace,
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
const {
	GATE_ENV,
	GATE_ROLE,
	appendGateRun,
	gatePositionLine,
	gateRepoName,
	gateRunLogPath,
	gateSeatChargeMb,
	isInSuite,
	startGatePids,
} = require("./lib/gate-seat.js");
const { withMergeParents } = require("./lib/merge-heads.js");
const {
	CEILING_CLOSE,
	armCeiling,
	ceilingHeadline,
	ceilingMs,
	killGroup,
} = require("./lib/suite-ceiling.js");

const LABEL = "queue-run.js";
const USAGE = `Usage: node ${path.join("scripts", "queue-run.js")} [--seat | --tsc | --gate] -- <command…>
Waits for a suite slot in the shared queue, then runs <command>: a node --test,
pytest or Python test file, npm run test:py, a declared suiteRunners script,
or an npm test script that does not run run-vitest.js (workflow-core#1776).
  --seat  wait once as a part-suite, then run <command>, a driver such as a
          mutation loop, whose \`run-vitest.js <file> --queue\` runs skip the
          queue and wait on the memory rung alone (workflow-core#2918)
  --tsc   wait for the machine-wide type-check slot, then run <command>, a
          type-check such as \`tsc --noEmit\` (workflow-core#3163)
  --gate  wait for the whole-suite slot as a commit gate, never refused at the
          wait bound, then run <command>, the repo's declared test command,
          under the suite ceiling (workflow-core#5274)`;

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

/**
 * What a `--tsc` wait prints in place of a suite's (workflow-core#3163), on the rung of
 * the launch's own compiler (workflow-core#4892).
 * @param {number} peakMb
 */
const buildTscWaitText = (peakMb) => ({
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

/* The weight a command naming its test files joins and asks the gate with
 * (workflow-core#5274, spec workflow-core#5273 §7): a part-suite, so it never takes or waits for the
 * whole-suite slot, its file count unread, so the rung charges it a whole
 * suite's workers and its marker its queue's peak. */
const NAMED_FILES_WEIGHT = { resolvedFiles: null, wholeSlot: false };

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
 * Why a plain launch is refused, or null where it queues.
 *
 * @param {string[]} words
 * @returns {string | null}
 */
function plainRefusal(words) {
	const reading = classify(words);
	if (reading === "unread" || reading === "queue") return null;
	return (
		REFUSALS[/** @type {keyof typeof REFUSALS} */ (reading)] ?? REFUSALS.none
	);
}

/**
 * A slot's refusal of a command that is itself a suite: `why`, or null where
 * the command runs none or will not read.
 *
 * @param {string} why
 * @returns {(words: string[]) => string | null}
 */
const suiteRefusedWith = (why) => (words) => {
	const reading = classify(words);
	return reading === "unread" || reading === "none" ? null : why;
};

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
 *   gateChargeMb?: number,
 *   gateLog?: string | null,
 *   ticket?: number | null,
 *   treeSample?: (pid: number) => { kb: number, pids: number[] },
 *   gatePidsDir?: string,
 *   schedule?: Parameters<typeof armCeiling>[0]["schedule"],
 *   sampleMs?: number,
 *   inSuite?: () => boolean,
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

/** @typedef {keyof typeof SLOT_KINDS} Slot */

/** @typedef {import("./lib/suite-queue.js").QueueSeat["stamps"]} Stamps */

/** @param {object} gate */
const waitOn = (gate) => () => gate;

const refusedRun = () => 1;

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
 * @typedef {{
 *   queue: Options,
 *   join: NonNullable<Parameters<typeof queueSeat>[0]>["join"],
 *   wait: (stamps: Stamps) => object,
 *   refused: (err: Out) => number,
 *   exitExtra?: { noWait?: boolean, chargeMb: number },
 *   sayPlace: () => void,
 *   start: (words: string[], launch: Launch) => import("node:child_process").ChildProcess,
 * }} SlotWait
 *
 * @typedef {{
 *   seat: ReturnType<typeof queueSeat>,
 *   options: Options,
 *   err: Out,
 *   finish: (code: number) => void,
 * }} Launch
 */

const sayNoPlace = () => {
	/* only a gate seat prints its place */
};

/**
 * @param {string | null} handed
 * @returns {SlotWait["start"]}
 */
const handing = (handed) => (words, launch) =>
	spawnCommand(words, { handed, ...launch });

/**
 * @param {Options} options
 * @returns {SlotWait}
 */
const buildSeatWait = (options) => ({
	queue: options,
	join: { ...options, weight: SEAT_WEIGHT },
	wait: waitOn({ gateWeight: SEAT_WEIGHT, part: true }),
	refused: refusedRun,
	sayPlace: sayNoPlace,
	start: handing(SEAT_ENV),
});

/**
 * The launch is charged the peak of the compiler its `tsc` resolves to from
 * here, stamped on its marker for the suite queue's climb and on its exit
 * line for the replay (workflow-core#4892).
 *
 * @param {Options} options
 * @param {string[]} words
 * @returns {SlotWait}
 */
function buildTscWait(options, words) {
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
		...buildTscWaitText(chargeMb),
	};
	const noWait = process.env[TSC_NO_WAIT_ENV] === "1";
	return {
		queue,
		join: { ...queue, chargeMb },
		wait: noWait ? tryOn(gate) : waitOn(gate),
		refused: noWait ? sayTscHeld : refusedRun,
		exitExtra: noWait ? { noWait: true, chargeMb } : { chargeMb },
		sayPlace: sayNoPlace,
		start: handing(TSC_SLOT_ENV),
	};
}

/**
 * A plain launch's wait: its marker carries the command's runner peak where
 * one is measured (workflow-core#4648), and a command naming its test files joins as a
 * part-suite (workflow-core#5274).
 *
 * @param {Options} options
 * @param {string[]} words
 * @returns {SlotWait}
 */
function buildOtherWait(options, words) {
	const charges = unwrapArgv(words).flatMap(({ words: inner }) => {
		const mb = queuedRunnerPeakMb(inner);
		return mb === undefined ? [] : [mb];
	});
	/* The heaviest run's: runs a `&` or `|` sets side by side are charged as
	 * that one alone. */
	const chargeMb = charges.length > 0 ? Math.max(...charges) : undefined;
	const charged = chargeMb === undefined ? options : { ...options, chargeMb };
	const part = isNamedFilesRun(words);
	return {
		queue: options,
		join: part ? { ...charged, weight: NAMED_FILES_WEIGHT } : charged,
		wait: waitOn(part ? { gateWeight: NAMED_FILES_WEIGHT, part: true } : {}),
		refused: refusedRun,
		sayPlace: sayNoPlace,
		start: handing(null),
	};
}

/**
 * Whether the command is a part-suite as the guard reads it (workflow-core#5274, spec
 * workflow-core#5273 §7): every run in it the queue takes names its test files
 * (lib/suite-launch.js `hasNamedTestFiles`). A reading that throws is logged
 * and read whole, which waits for the slot rather than slip past it.
 *
 * @param {string[]} words
 * @returns {boolean}
 */
function isNamedFilesRun(words) {
	const log = logger(LABEL);
	try {
		const ports = buildLaunchPorts({ root: hostRoot(), log });
		const runs = unwrapArgv(words)
			.map(({ words: inner }) => inner)
			.filter((inner) => inner.length > 0 && isQueueable(inner, ports));
		return runs.length > 0 && runs.every(hasNamedTestFiles);
	} catch (e) {
		log(`suite-launch reading threw — taken whole: ${caught(e).message}`);
		return false;
	}
}

/**
 * A gate seat's wait (workflow-core#5274): the suite queue joined whole, role `gate`,
 * carrying who holds it and its charge, waiting with no bound, its place
 * printed on joining and at each change.
 *
 * @param {Options} options
 * @param {string[]} words
 * @returns {SlotWait}
 */
function buildGateWait(options, words) {
	const session =
		options.sessionId === undefined ? idSeam.fromEnv() : options.sessionId;
	const holder = {
		repo: gateRepoName(),
		session,
		command: words.join(" "),
	};
	const err = options.err ?? STDERR;
	const clock = options.clock ?? Date.now;
	const started = clock();
	const sleep =
		options.sleepFn ??
		((/** @type {number} */ ms) =>
			new Promise((resolve) => setTimeout(resolve, ms)));
	let said = "";
	const sayPlace = () => {
		const place = readSlotPlace(options);
		const key = `${place.position} ${place.holder?.pid ?? ""}`;
		if (key === said) return;
		said = key;
		err.write(
			gatePositionLine({
				...place,
				waitedS: Math.round((clock() - started) / 1000),
			}),
		);
	};
	return {
		queue: options,
		join: {
			...options,
			role: GATE_ROLE,
			chargeMb: options.gateChargeMb ?? readGateChargeMb(err),
			holder,
		},
		wait: () => ({
			timeoutMs: Number.POSITIVE_INFINITY,
			waiting:
				"waiting for the whole-suite slot as a commit gate, never refused at the wait bound (workflow-core#5274)",
			cap: "one whole suite runs at a time (workflow-core#2680)",
			sleepFn: (/** @type {number} */ ms) => {
				sayPlace();
				return sleep(ms);
			},
		}),
		refused: refusedRun,
		sayPlace,
		start: (_words, launch) =>
			spawnGate({ ...launch, holder, waitMs: clock() - started }),
	};
}

/**
 * This repo's gate-seat charge, off its config. A config that will not read
 * is named on `err` and the seat charged the default (workflow-core#5274): the seat still
 * waits and runs, never charged nothing.
 * @param {Out} err
 * @returns {number}
 */
function readGateChargeMb(err) {
	try {
		const { readConfig } = require("./lib/workflow-core-config.js");
		return gateSeatChargeMb(readConfig({ root: hostRoot(), quiet: true }));
	} catch (e) {
		const fallback = gateSeatChargeMb(null);
		err.write(
			`${LABEL}: .claude/workflow-core.json would not read (${caught(e).message}); the gate seat is charged the default ${fallback} MB (workflow-core#5274).\n`,
		);
		return fallback;
	}
}

/**
 * The issue `session` holds, the newest claimed, or null.
 * @param {string | null} session
 * @returns {number | null}
 */
function readTicket(session) {
	if (!session) return null;
	try {
		const { readClaimedIssues } = require("./lib/arbiter-issue-claims.js");
		return readClaimedIssues(session)[0] ?? null;
	} catch {
		/* An unreadable claim store costs the record line its ticket, never the
		 * commit (workflow-core#5274). */
		return null;
	}
}

/** @param {string[]} words */
const asGiven = (words) => words;

/**
 * One kind per slot flag and `other` for a launch with none (workflow-core#2918, workflow-core#3163,
 * workflow-core#5274), "slot" naming the flag family, the gate seat among them.
 *
 * @satisfies {Record<string, {
 *   refusal: (words: string[]) => string | null,
 *   heldMarkerEnv: string,
 *   runsAtOnceInSuite: (options: Options) => boolean,
 *   wait: (options: Options, words: string[]) => SlotWait,
 *   argv: (words: string[]) => string[],
 * }>}
 */
const SLOT_KINDS = {
	seat: {
		refusal: suiteRefusedWith(SEAT_REFUSAL),
		heldMarkerEnv: GATE_ENV,
		runsAtOnceInSuite: () => false,
		wait: buildSeatWait,
		argv: asGiven,
	},
	tsc: {
		refusal: suiteRefusedWith(TSC_REFUSAL),
		heldMarkerEnv: TSC_SLOT_ENV,
		runsAtOnceInSuite: () => false,
		wait: buildTscWait,
		argv: asGiven,
	},
	gate: {
		/* A gate's command is taken by its role, never by the classifier. */
		refusal: () => null,
		heldMarkerEnv: GATE_ENV,
		runsAtOnceInSuite: (options) =>
			(options.inSuite ?? (() => isInSuite(options)))(),
		wait: buildGateWait,
		/* A gate's command is one shell string, as spawnGate runs it, held or
		 * not. */
		argv: (words) => ["sh", "-c", words.join(" ")],
	},
	other: {
		refusal: plainRefusal,
		heldMarkerEnv: GATE_ENV,
		runsAtOnceInSuite: () => false,
		wait: buildOtherWait,
		argv: asGiven,
	},
};

const SLOT_FLAGS = /** @type {Exclude<Slot, "other">[]} */ (
	Object.keys(SLOT_KINDS).filter((slot) => slot !== "other")
);

const SLOT_FLAG_SPEC = Object.fromEntries(
	SLOT_FLAGS.map((slot) => [`--${slot}`, /** @type {const} */ ("boolean")]),
);

/**
 * The slot the flags ask for, `other` for none; undefined where they ask for
 * more than one.
 *
 * @param {Record<string, unknown>} flags
 * @returns {Slot | undefined}
 */
function slotOf(flags) {
	const slots = SLOT_FLAGS.filter((slot) => flags[`--${slot}`] === true);
	if (slots.length > 1) return;
	return slots[0] ?? "other";
}

/**
 * @param {string[]} argv
 * @param {Options} [options]
 * @returns {Promise<number>}
 */
async function main(argv, options = {}) {
	const parsed = parseOrCode(argv, {
		usage: USAGE,
		flags: SLOT_FLAG_SPEC,
		min: 1,
		max: Number.POSITIVE_INFINITY,
	});
	if (typeof parsed === "number") return parsed;
	const words = parsed.positionals;
	const slot = slotOf(parsed.flags);
	const err = options.err ?? STDERR;
	if (slot === undefined) {
		err.write(
			`${LABEL}: --seat, --tsc and --gate hold different slots; give one.\n`,
		);
		return 2;
	}
	const why = SLOT_KINDS[slot].refusal(words);
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
		kind: slot,
		session:
			options.sessionId === undefined ? idSeam.fromEnv() : options.sessionId,
		label: LABEL,
		err,
	});

	const kind = SLOT_KINDS[slot];
	/* A slot held already in this process tree runs the command at once, in
	 * that slot: a `--tsc` launch inside a `--tsc` command's tree, which would
	 * otherwise wait behind it forever (workflow-core#3404), and any other launch inside a
	 * gate seat's tree (workflow-core#5274). */
	const held = heldMarker(kind.heldMarkerEnv, options) !== null;
	const unseated = held || kind.runsAtOnceInSuite(options);
	const slotted = kind.wait(options, words);
	const { queue, join, wait, refused, exitExtra } = slotted;
	/** @type {import("node:child_process").ChildProcess | null} */
	let child = null;
	/* A killed waiter exits on the spot: its poll would otherwise run on. Once
	 * the wait has ended a signal is the command's to answer, and this process
	 * exits on the command's exit. */
	const seat = queueSeat({
		queue,
		join: unseated ? false : join,
		logExit: withExitExtra(logExit, exitExtra),
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

	if (!unseated) slotted.sayPlace();
	const outcome = unseated
		? null
		: await seat.wait({
				label: LABEL,
				...queue,
				...wait(seat.stamps),
			});
	const launch = { seat, options, err, finish };
	if (outcome === "refused") finish(refused(err));
	else
		child = held
			? spawnCommand(kind.argv(words), { handed: null, ...launch })
			: slotted.start(words, launch);
	return done;
}

/**
 * The exit logger, carrying a slot's extra fields on each line where it has
 * any: a killed line keeps the charge the replay reads (workflow-core#4921), but not
 * `noWait`, which marks a try's verdict, refused or opened, for
 * guard-typecheck-owed.js.
 *
 * @param {ReturnType<typeof queueExitLogger>} logExit
 * @param {{ noWait?: boolean, chargeMb: number } | undefined} exitExtra
 * @returns {ReturnType<typeof queueExitLogger>}
 */
function withExitExtra(logExit, exitExtra) {
	if (!exitExtra) return logExit;
	const { noWait: _noWait, ...charge } = exitExtra;
	return (reason, waitMs, extra) =>
		logExit(reason, waitMs, {
			...extra,
			...(reason === "killed" ? charge : exitExtra),
		});
}

/**
 * Start a gate seat's command (workflow-core#5274): in a process group of its own, its
 * marker in GATE_ENV, under the suite ceiling, which kills the group and reads
 * red; its tree's PSS sampled for its peak from spawn (lib/admission.js
 * `sampleTreePeak`), each sample's pids on the seat's pid record
 * (lib/gate-seat.js); and, on its exit, one line on the gate-run record.
 * Run in the committing checkout, with no throwaway worktree's runner to
 * hand them, it hands this checkout's merge parents to the overlay a touched
 * run moves into (lib/merge-heads.js, workflow-core#5334).
 *
 * @param {{
 *   seat: ReturnType<typeof queueSeat>,
 *   options: Options,
 *   err: Out,
 *   finish: (code: number) => void,
 *   holder: { repo: string | null, session: string | null, command: string },
 *   waitMs: number,
 * }} launch
 */
function spawnGate({ seat, options, err, finish, holder, waitMs }) {
	const { command } = holder;
	const clock = options.clock ?? Date.now;
	const {
		readTreeSample,
		sampleTreePeak,
		TREE_PEAK_SAMPLE_MS,
	} = require("./lib/admission.js");
	const readTree = options.treeSample ?? readTreeSample;
	const sampleMs = options.sampleMs ?? TREE_PEAK_SAMPLE_MS;
	/** @type {ReturnType<typeof startGatePids> | undefined} */
	let pids;
	let unreadSamples = 0;
	/** @type {string | null} */
	let firstUnread = null;
	/** @param {number} pid */
	const treePss = (pid) => {
		try {
			const sample = readTree(pid);
			pids?.see(sample.pids);
			return sample.kb;
		} catch (error) {
			/* An unreadable sample costs that sample, never the gate run
			 * (workflow-core#5274), and is named at the close: the peak is read by hand to
			 * set `gateSeatMb`. */
			unreadSamples += 1;
			firstUnread ??= caught(error).message;
			return 0;
		}
	};
	const running = (options.spawnFn ?? spawn)("sh", ["-c", command], {
		stdio: ["inherit", "inherit", 1],
		detached: true,
		env: {
			...withMergeParents(process.cwd(), process.env),
			[GATE_ENV]: seat.ticket,
		},
	});
	const spawnedAt = clock();
	/** @type {ReturnType<typeof sampleTreePeak> | undefined} */
	let sampler;
	/** @type {import("./lib/gate-seat.js").GateOutcome | null} */
	let forced = null;
	const ceiling = ceilingMs();
	const held = armCeiling({
		pgid: running.pid,
		ms: ceiling,
		...(options.schedule ? { schedule: options.schedule } : {}),
		onCeiling: () => {
			forced = "ceiling";
			err.write(
				`${LABEL}: ${ceilingHeadline(`'${holder.command}'`, { elapsed: clock() - spawnedAt, ceiling })}. ${CEILING_CLOSE.join(" ")}\n`,
			);
			const unkilled = running.pid ? killGroup(running.pid) : null;
			if (unkilled)
				err.write(
					`${LABEL}: the gate's process group could not be killed (${unkilled}); a worker may outlive this report.\n`,
				);
		},
	});
	if (held.error)
		err.write(`${LABEL}: suite deadline not written (${held.error})\n`);
	running.once("spawn", () => {
		seat.spawned();
		pids = startGatePids(holder, {
			sampleMs,
			...(options.gatePidsDir ? { dir: options.gatePidsDir } : {}),
		});
		sampler = sampleTreePeak(running.pid, { treePss, ms: sampleMs });
	});
	/** @param {number} code @param {import("./lib/gate-seat.js").GateOutcome} outcome */
	const close = (code, outcome) => {
		const { peakKb } = sampler?.stop() ?? { peakKb: 0 };
		const unrecorded = pids?.stop() ?? null;
		if (unrecorded)
			err.write(
				`${LABEL}: this gate run's pids were not recorded (${unrecorded}), so a memory kill under it will not be named its (workflow-core#5269).\n`,
			);
		if (unreadSamples > 0)
			err.write(
				`${LABEL}: ${unreadSamples} of this gate run's tree samples would not read (${firstUnread}), so its recorded peakTreeMb is a floor; set no gateSeatMb from it.\n`,
			);
		held.release();
		const file =
			options.gateLog === undefined ? gateRunLogPath() : options.gateLog;
		const landed = appendGateRun(file, {
			at: new Date(clock()).toISOString(),
			repo: holder.repo,
			command: holder.command,
			session: holder.session,
			ticket:
				options.ticket === undefined
					? readTicket(holder.session)
					: options.ticket,
			waitS: Math.round(waitMs / 1000),
			runS: Math.round((clock() - spawnedAt) / 1000),
			outcome,
			peakTreeMb: Math.round(peakKb / 1024),
		});
		if (!landed && file)
			err.write(
				`${LABEL}: this gate run was not recorded on ${file}, so the gate-run count will miss it.\n`,
			);
		finish(code);
	};
	running.once("error", (error) => {
		err.write(`${LABEL}: ${command} would not start — ${error.message}\n`);
		close(127, "red");
	});
	running.once("exit", (code, signal) => {
		if (forced === "ceiling") return close(1, "ceiling");
		const status = exitStatus(code, signal);
		if (signal) return close(status, "killed");
		close(status, status === 0 ? "pass" : "red");
	});
	return running;
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
