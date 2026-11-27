#!/usr/bin/env node

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { caught } = require("./lib/caught.js");
const { noop } = require("./lib/noop.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { logger } = require("./lib/entry-input.js");
const { hostRoot } = require("./lib/host-root.js");
const {
	queueExitLogPath,
	queueExitLogger,
} = require("./lib/queue-exit-log.js");
const idSeam = require("./lib/session-id.js");
const { monotonicMs } = require("./lib/clock.js");
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
const { captureRun, joinOrSeat, readJoinKey } = require("./lib/tsc-join.js");
const { unwrapArgv } = require("./lib/shell-parse.js");
const {
	TSC_BUSY_EXIT,
	TSC_NO_WAIT_ENV,
	TSC_SLOT_ENV,
	defaultTscQueueDir,
	launchPeakMb,
	memoryDenial,
	tscDenial,
	tscLaunchBin,
} = require("./lib/tsc-slot.js");
const { isCapped } = require("./lib/part-suite-peak.js");
const { rungMb } = require("./lib/suite-ladder.js");
const { readWindowsRecorded } = require("./lib/windows-memory.js");
const { writeFd } = require("./lib/write-fd.js");
const {
	GATE_ENV,
	GATE_ROLE,
	GATE_SELECTION_ENV,
	appendGateRun,
	gatePositionLine,
	gateRepoName,
	gateRunLogPath,
	gateSeatChargeMb,
	isInSuite,
	measuredGatePeak,
	readGateRunsAt,
	readGateSelection,
	startGatePids,
	wholeRunPeakMb,
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
const USAGE = `Usage: node ${path.join("scripts", "queue-run.js")} [--seat | --tsc | --gate --tree <sha>] -- <command…>
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
          under the suite ceiling (workflow-core#5274), recorded against --tree, the sha
          of the tree it tests (workflow-core#5448)`;

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

/** @param {number} peakMb */
const buildTscWaitText = (peakMb) => ({
	waiting: `waiting for the type-check slot: a \`tsc\` running, a suite starting (workflow-core#3203), or MemAvailable, less what a climbing suite has yet to draw (workflow-core#3416), under its ~${rungMb(peakMb)} MB rung, or Windows' own free memory under what it draws (workflow-core#4557)`,
	cap: "one `tsc` runs at a time (workflow-core#3163)",
	traceLimbs: true,
});

/**
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

const SEAT_WEIGHT = { resolvedFiles: 1, wholeSlot: false };

const NAMED_FILES_WEIGHT = { resolvedFiles: null, wholeSlot: false };

/**
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
 *   runStore?: string,
 *   ticket?: number | null,
 *   treeSample?: (pid: number) => { kb: number, pids: number[] },
 *   gatePidsDir?: string,
 *   schedule?: Parameters<typeof armCeiling>[0]["schedule"],
 *   sampleMs?: number,
 *   inSuite?: () => boolean,
 *   shortGate?: typeof shortGateDenial,
 *   tree?: string,
 *   stdout?: Out,
 *   worktree?: { toplevel: string, cwd: string },
 * }} Options
 */

/** @param {Options} options */
const sessionOf = (options) =>
	options.sessionId === undefined ? idSeam.fromEnv() : options.sessionId;

/** @type {Out} */
const STDERR = { write: (s) => writeFd(2, s) };

/** @type {Out} */
const STDOUT = { write: (s) => writeFd(1, s) };

/**
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

/** @param {{ gate: (climbMb: number) => import("./lib/gate-wait.js").GateDenial | null }} gate */
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
		`${LABEL}: the type-check slot is held, by a \`tsc\` running, a suite starting (workflow-core#3203), MemAvailable, less what a climbing suite has yet to draw (workflow-core#3416), under its rung, or this session's own two places in the queue (workflow-core#5595) — not run, as ${TSC_NO_WAIT_ENV} asks (workflow-core#3278)\n`,
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
 *   joining?: Omit<import("./lib/tsc-join.js").Joining, "logExit" | "signals">,
 * }} SlotWait
 *
 * @typedef {{
 *   seat: ReturnType<typeof queueSeat>,
 *   options: Options,
 *   err: Out,
 *   finish: (code: number) => void,
 * }} Launch
 */

const sayNoPlace = noop;

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
	/** @type {SlotWait} */
	const plain = {
		queue,
		join: { ...queue, chargeMb },
		wait: noWait ? tryOn(gate) : waitOn(gate),
		refused: noWait ? sayTscHeld : refusedRun,
		exitExtra: noWait ? { noWait: true, chargeMb } : { chargeMb },
		sayPlace: sayNoPlace,
		start: handing(TSC_SLOT_ENV),
	};
	const key = noWait ? null : readJoinKey(words, options.worktree);
	return key ? withJoining(plain, options, key) : plain;
}

/**
 * @param {SlotWait} plain
 * @param {Options} options
 * @param {import("./lib/tsc-join.js").JoinKey} key
 * @returns {SlotWait}
 */
function withJoining(plain, options, key) {
	const { queue } = plain;
	const session = sessionOf(options);
	const pid = options.pid ?? process.pid;
	const asked = {
		wall: (options.clock ?? Date.now)(),
		mono: (options.monoClock ?? monotonicMs)(),
	};
	const where = {
		...queue,
		pid,
		queueDir: queue.queueDir ?? defaultTscQueueDir(),
		out: options.out ?? process.stderr,
		label: LABEL,
	};
	return {
		...plain,
		join: {
			...plain.join,
			holder: { ...key, session },
			clock: () => asked.wall,
		},
		start: (startWords, launch) =>
			spawnCommand(startWords, {
				handed: TSC_SLOT_ENV,
				...launch,
				capture: captureRun(where),
			}),
		joining: {
			...where,
			session,
			key,
			asked,
			...(options.clock ? { wallClock: options.clock } : {}),
			stdout: options.stdout ?? STDOUT,
			err: options.err ?? STDERR,
			exitStatus,
		},
	};
}

/**
 * @param {Options} options
 * @param {string[]} words
 * @returns {SlotWait}
 */
function buildOtherWait(options, words) {
	const charges = unwrapArgv(words).flatMap(({ words: inner }) => {
		const mb = queuedRunnerPeakMb(inner);
		return mb === undefined ? [] : [mb];
	});
	const chargeMb = charges.length > 0 ? Math.max(...charges) : undefined;
	const charged = chargeMb === undefined ? options : { ...options, chargeMb };
	const part = isNamedFilesRun(words);
	const capMb = part ? readWholeRunPeak(options) : null;
	/** @type {import("./lib/part-suite-peak.js").PartAdmission | undefined} */
	let admission;
	return {
		queue: options,
		join: part ? { ...charged, weight: NAMED_FILES_WEIGHT } : charged,
		wait: waitOn(
			part
				? {
						gateWeight: NAMED_FILES_WEIGHT,
						part: true,
						...(capMb === null ? {} : { gateCapMb: capMb }),
						onAdmission: (
							/** @type {import("./lib/part-suite-peak.js").PartAdmission} */ a,
						) => {
							admission = a;
						},
					}
				: {},
		),
		refused: refusedRun,
		sayPlace: sayNoPlace,
		start: (startWords, launch) =>
			isCapped(admission)
				? startCapped(startWords, launch, admission)
				: spawnCommand(startWords, { handed: null, ...launch }),
	};
}

/**
 * @param {string[]} words
 * @param {Launch} launch
 * @param {import("./lib/part-suite-peak.js").PartAdmission} admission
 */
function startCapped(words, launch, admission) {
	const { startSampler } = require("./lib/run-memory.js");
	const { runStore } = launch.options;
	let memory;
	try {
		memory = startSampler(
			{
				session: sessionOf(launch.options),
				kind: "named",
				argv: words,
				files: [],
				fileCount: 0,
				repo: gateRepoName() ?? path.basename(hostRoot()),
				mode: admission.mode,
				admission,
			},
			runStore === undefined ? {} : { dir: runStore },
		);
	} catch (e) {
		launch.err.write(
			`${LABEL}: the capped run's memory record would not start — the peak tripwire will not count it live (workflow-core#5812): ${caught(e).message}\n`,
		);
		return spawnCommand(words, { handed: null, ...launch });
	}
	const child = spawnCommand(words, {
		handed: null,
		...launch,
		finish: (code) => {
			try {
				memory.stop();
			} finally {
				launch.finish(code);
			}
		},
	});
	memory.setMain(child.pid ?? null);
	return child;
}

/**
 * @param {Options} options
 * @returns {number | null}
 */
function readWholeRunPeak(options) {
	const file =
		options.gateLog === undefined ? gateRunLogPath() : options.gateLog;
	const runs = readGateRunsAt(file);
	if (runs !== null) return wholeRunPeakMb(runs, gateRepoName());
	logger(LABEL)(
		`the gate-run record ${file} would not read — a part-suite charged the ladder's rung uncapped (workflow-core#5802)`,
	);
	return null;
}

/**
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
 * @param {Options} options
 * @param {string[]} words
 * @returns {SlotWait}
 */
function buildGateWait(options, words) {
	const session = sessionOf(options);
	const holder = {
		repo: gateRepoName(),
		session,
		command: words.join(" "),
	};
	const { tree } = options;
	if (tree === undefined)
		throw new Error(
			"a gate seat's wait needs the --tree its run is recorded against",
		);
	const err = options.err ?? STDERR;
	const clock = options.monoClock ?? monotonicMs;
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
	const peak = readGatePeak(options, holder, err);
	const shortMb = peak?.short ? peak.peakMb : null;
	const unbounded = {
		timeoutMs: Number.POSITIVE_INFINITY,
		cap: "one whole suite runs at a time (workflow-core#2680)",
		sleepFn: (/** @type {number} */ ms) => {
			sayPlace();
			return sleep(ms);
		},
	};
	const seat = { ...options, role: GATE_ROLE, holder };
	return {
		queue: options,
		join:
			shortMb === null
				? {
						...seat,
						chargeMb:
							peak?.peakMb ?? options.gateChargeMb ?? readGateChargeMb(err),
					}
				: { ...seat, chargeMb: shortMb, weight: NAMED_FILES_WEIGHT },
		wait: () =>
			shortMb === null
				? {
						...unbounded,
						waiting:
							"waiting for the whole-suite slot as a commit gate, never refused at the wait bound (workflow-core#5274)",
					}
				: {
						...unbounded,
						gate: (/** @type {number} */ climbMb) =>
							(options.shortGate ?? shortGateDenial)(climbMb, shortMb),
						part: true,
						waiting: `waiting as a short commit gate, a part-suite (workflow-core#5450): MemAvailable, less what a climbing suite has yet to draw, under its ~${rungMb(shortMb)} MB rung, or Windows' own free memory under what it draws`,
					},
		refused: refusedRun,
		sayPlace,
		start: (_words, launch) =>
			spawnGate({
				...launch,
				holder,
				tree,
				waitMs: clock() - started,
				part: shortMb !== null,
			}),
	};
}

/**
 * @param {Options} options
 * @param {{ repo: string | null, command: string }} holder
 * @param {Out} err
 * @returns {import("./lib/gate-seat.js").GatePeak | null}
 */
function readGatePeak(options, holder, err) {
	const file =
		options.gateLog === undefined ? gateRunLogPath() : options.gateLog;
	const runs = readGateRunsAt(file);
	if (runs === null) {
		if (file !== null)
			err.write(
				`${LABEL}: the gate-run record ${file} would not read; this gate waits for the whole-suite slot, charged its configured or default seat (workflow-core#5450, workflow-core#5591).\n`,
			);
		return null;
	}
	return measuredGatePeak(runs, holder);
}

/**
 * @param {number} climbMb
 * @param {number} peakMb
 */
function shortGateDenial(climbMb, peakMb) {
	const log = logger(LABEL);
	const ports = buildHostPorts(hostRoot(), log);
	const mb = ports.availableMb();
	if (mb === null)
		log("MemAvailable unreadable — the short gate's rung unread");
	const windows = readWindowsRecorded(
		ports.windowsMemory,
		log,
		"the short gate",
	);
	return memoryDenial(mb, climbMb, { windows, peakMb });
}

/**
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
 * @param {string | null} session
 * @returns {number | null}
 */
function readTicket(session) {
	if (!session) return null;
	try {
		const { readClaimedIssues } = require("./lib/arbiter-issue-claims.js");
		return readClaimedIssues(session)[0] ?? null;
	} catch {
		return null;
	}
}

/** @param {string[]} words */
const asGiven = (words) => words;

/**
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
		refusal: () => null,
		heldMarkerEnv: GATE_ENV,
		runsAtOnceInSuite: (options) =>
			(options.inSuite ?? (() => isInSuite(options)))(),
		wait: buildGateWait,
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

const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const SLOT_FLAGS = /** @type {Exclude<Slot, "other">[]} */ (
	Object.keys(SLOT_KINDS).filter((slot) => slot !== "other")
);

const SLOT_FLAG_SPEC = Object.fromEntries(
	SLOT_FLAGS.map((slot) => [`--${slot}`, /** @type {const} */ ("boolean")]),
);

/**
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
		flags: { ...SLOT_FLAG_SPEC, "--tree": "value" },
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
	const tree = parsed.flags["--tree"];
	if ((slot === "gate") !== (typeof tree === "string")) {
		err.write(
			`${LABEL}: --gate and --tree go together: a gate run is recorded against the sha of the tree it tests (workflow-core#5448).\n`,
		);
		return 2;
	}
	if (typeof tree === "string" && !GIT_SHA.test(tree)) {
		err.write(`${LABEL}: --tree takes a git tree's sha, not '${tree}'.\n`);
		return 2;
	}
	const why = SLOT_KINDS[slot].refusal(words);
	if (why) {
		err.write(`${LABEL}: not queued — ${why}\n`);
		return 2;
	}
	return run(
		words,
		slot,
		typeof tree === "string" ? { ...options, tree } : options,
		err,
	);
}

/**
 * @param {string[]} words
 * @param {Slot} slot
 * @param {Options} options
 * @param {Out} err
 * @returns {Promise<number>}
 */
async function run(words, slot, options, err) {
	const session = sessionOf(options);
	const logExit = queueExitLogger({
		file:
			options.queueLog === undefined
				? queueExitLogPath(hostRoot())
				: options.queueLog,
		kind: slot,
		session,
		label: LABEL,
		err,
	});

	const kind = SLOT_KINDS[slot];
	const held = heldMarker(kind.heldMarkerEnv, options) !== null;
	const unseated = held || kind.runsAtOnceInSuite(options);
	const slotted = kind.wait(options, words);
	const { queue, join, wait, refused, exitExtra, joining } = slotted;
	const logged = withExitExtra(logExit, exitExtra);
	const signals = signalsOf(options);
	/** @type {import("node:child_process").ChildProcess | null} */
	let child = null;
	const seatAfter = (/** @type {number} */ waitedMs) => {
		const made = queueSeat({
			queue,
			join: unseated ? false : { ...join, session },
			waitedMs,
			logExit: logged,
			signals: {
				...signals,
				onSignal: (signal) => made === seat && passOn(child, signal),
			},
		});
		return made;
	};
	let seat = seatAfter(0);
	if (joining && !unseated) {
		const joined = await joinOrSeat(
			{ ...joining, logExit: logged, signals },
			seat,
			seatAfter,
		);
		if ("code" in joined) return joined.code;
		seat = joined.seat;
	}
	/** @type {(code: number) => void} */
	let finish = noop;
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

/** @param {Options} options */
const signalsOf = (options) => ({
	...(options.signals ? { emitter: options.signals } : {}),
	...(options.exit ? { exit: options.exit } : {}),
});

/**
 * @param {import("node:child_process").ChildProcess | null} child
 * @param {NodeJS.Signals} signal
 * @returns {boolean}
 */
function passOn(child, signal) {
	if (!child) return false;
	child.kill(signal);
	return true;
}

/**
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
 * @param {Options} options
 * @param {Out} err
 * @param {{ repo: string | null, session: string | null, command: string }} holder
 * @param {Omit<import("./lib/gate-seat.js").GateRun, "at" | "repo" | "command" | "session" | "ticket">} measured
 */
function recordGateRun(options, err, holder, measured) {
	const file =
		options.gateLog === undefined ? gateRunLogPath() : options.gateLog;
	const landed = appendGateRun(file, {
		at: new Date().toISOString(),
		repo: holder.repo,
		command: holder.command,
		session: holder.session,
		ticket:
			options.ticket === undefined
				? readTicket(holder.session)
				: options.ticket,
		...measured,
	});
	if (!landed && file)
		err.write(
			`${LABEL}: this gate run was not recorded on ${file}, so the gate-run count will miss it.\n`,
		);
}

/**
 * @param {{
 *   seat: ReturnType<typeof queueSeat>,
 *   options: Options,
 *   err: Out,
 *   finish: (code: number) => void,
 *   holder: { repo: string | null, session: string | null, command: string },
 *   tree: string,
 *   waitMs: number,
 *   part: boolean,
 * }} launch
 */
function spawnGate({ seat, options, err, finish, holder, tree, waitMs, part }) {
	const { command } = holder;
	const selection = makeGateSelectionFile(err);
	const clock = options.monoClock ?? monotonicMs;
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
			...selection.env,
		},
	});
	const spawnedAt = clock();
	const spawnedWallAt = Date.now();
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
		const chose = selection.take();
		recordGateRun(options, err, holder, {
			tree,
			waitS: Math.round(waitMs / 1000),
			runS: Math.round((clock() - spawnedAt) / 1000),
			wallS: Math.round((Date.now() - spawnedWallAt) / 1000),
			outcome,
			peakTreeMb: Math.round(peakKb / 1024),
			...(part ? { part: true } : {}),
			...(chose === null ? {} : { selection: chose }),
		});
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
 * @param {Out} err
 * @returns {{ env: Record<string, string>, take: () => string | null }}
 */
function makeGateSelectionFile(err) {
	try {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-gate-selection-"));
		const file = path.join(dir, "selection");
		return {
			env: { [GATE_SELECTION_ENV]: file },
			take: () => {
				const chose = readGateSelection(file);
				try {
					fs.rmSync(dir, { recursive: true, force: true });
				} catch (error) {
					err.write(
						`${LABEL}: this gate run's selection file was not removed (${caught(error).message}); remove ${dir} by hand.\n`,
					);
				}
				return chose;
			},
		};
	} catch (error) {
		err.write(
			`${LABEL}: no selection file would make (${caught(error).message}), so this gate run's record will carry no selection.\n`,
		);
		return { env: {}, take: () => null };
	}
}

/**
 * @param {string[]} words
 * @param {{
 *   handed: string | null | undefined,
 *   seat: ReturnType<typeof queueSeat>,
 *   options: Options,
 *   err: Out,
 *   finish: (code: number) => void,
 *   capture?: ReturnType<typeof captureRun>,
 * }} launch
 */
function spawnCommand(words, { handed, seat, options, err, finish, capture }) {
	const [command = "", ...args] = words;
	const running = (options.spawnFn ?? spawn)(command, args, {
		stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
		...(handed ? { env: { ...process.env, [handed]: seat.ticket } } : {}),
	});
	const wall = options.clock ?? Date.now;
	/** @type {number | null} */
	let spawnedAt = null;
	running.once("spawn", () => {
		spawnedAt = wall();
		seat.spawned();
	});
	if (capture) {
		tee(running.stdout, [options.stdout ?? STDOUT, { write: capture.out }]);
		tee(running.stderr, [err, { write: capture.err }]);
	}
	let ended = false;
	/** @param {number} code */
	const end = (code) => {
		if (ended) return;
		ended = true;
		finish(code);
		capture?.release();
	};
	running.once("error", (error) => {
		err.write(`${LABEL}: ${command} would not start — ${error.message}\n`);
		capture?.close();
		end(127);
	});
	running.once(capture ? "close" : "exit", (code, signal) => {
		if (spawnedAt !== null)
			capture?.settle({ code, signal, spawnedAt, endedAt: wall() });
		end(exitStatus(code, signal));
	});
	return running;
}

/**
 * @param {import("node:stream").Readable | null} stream
 * @param {Out[]} sinks
 */
function tee(stream, sinks) {
	if (!stream) return;
	stream.setEncoding("utf8");
	stream.on("data", (/** @type {string} */ text) => {
		for (const sink of sinks) sink.write(text);
	});
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
