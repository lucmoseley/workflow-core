/*
 * gate-seat.js — the gate seat (#5274, spec #5273 §1-§2): the suite-queue
 * hold one gate run takes, a gate run being one run of a repo's declared test
 * command for one commit's verdict, however many runner processes it starts
 * (GLOSSARY.md).
 *
 * THE SEAT IS THE WHOLE-SUITE SLOT. `queue-run.js --gate` joins the suite
 * queue's FIFO as a whole suite, marked role `gate`, and hands its command the
 * marker's path in GATE_ENV. The marker carries the holder pid, the repo, the
 * session and the command, and the seat's charge in `chargeMb`.
 *
 * THE ANCESTRY IS THE TEST, never the variable alone (`heldMarker`): a runner
 * the seat's command starts counts as the seat, and one outside the seat's
 * process tree that inherited the variable counts as itself.
 *
 * THE CHARGE is the repo's `gateSeatMb`, set by hand to the highest
 * `peakTreeMb` on its gate-run record, else the whole-suite rung. Admission
 * holds it while a seat is queued or running, less what the seat's processes
 * already draw (lib/admission.js `gateHeldMb`). The queue's own readers of
 * the seats, `readLiveGates` and `readGateSeats`, are lib/suite-queue.js's.
 *
 * THE GATE-RUN RECORD is `.gate-runs.jsonl` under the canonical checkout's
 * markers directory, one line per gate run, kept 30 days like the queue-exit
 * log (lib/queue-exit-log.js), whose figure it copies, unmeasured. It is the
 * one source of gate-run counts.
 *
 * A GATE INSIDE A RUNNING SUITE'S PROCESS TREE takes no seat: a test
 * committing in a fixture repo runs in the slot and on the rung its suite
 * already holds, and would otherwise wait on that suite for good. It still
 * runs under the ceiling and is recorded.
 */

const fs = require("node:fs");
const path = require("node:path");
const { readAncestorsOf, readParentOf } = require("./proc-stat.js");
const { procRoot } = require("./proc-root.js");
const { isOtherRunner } = require("./suite-launch.js");
const { markersDir } = require("./marker-root.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");
const { repoRoot } = require("./test-pass-marker.js");
const { WHOLE_SUITE_WORKERS } = require("./suite-bounded.js");
const { isVitestRunnerLine, suiteRungMb } = require("./suite-ladder.js");

/* The variable a gate seat hands its command, naming its marker. */
const GATE_ENV = "WFC_GATE_SEAT";
/* The marker role admission reads the seat by, as it reads the lander's. */
const GATE_ROLE = "gate";
/* A repo declaring no `gateSeatMb` is charged the whole-suite rung, 3,350 MB:
 * unmeasured for a non-vitest runner, and never under-charging one. */
const GATE_SEAT_DEFAULT_MB = suiteRungMb(WHOLE_SUITE_WORKERS);

const GATE_RUN_LOG = ".gate-runs.jsonl";
const GATE_RUN_RETAIN_MS = 30 * DAY_MS;

/** @typedef {"pass" | "red" | "ceiling" | "killed"} GateOutcome */
/**
 * @typedef {object} GateRun one gate run's record line
 * @property {string} at its end, ISO
 * @property {string | null} repo the canonical checkout's directory name
 * @property {string} command
 * @property {string | null} session
 * @property {number | null} ticket the issue the session holds
 * @property {number} waitS
 * @property {number} runS
 * @property {GateOutcome} outcome
 * @property {number} peakTreeMb the command's process-tree PSS peak
 */

/**
 * A repo's gate-seat charge: its declared `gateSeatMb`, else the whole-suite
 * rung.
 * @param {{ gateSeatMb?: number } | null} config
 */
const gateSeatChargeMb = (config) => config?.gateSeatMb ?? GATE_SEAT_DEFAULT_MB;

/**
 * The gate-run record's path for the checkout at `root`, or null where git
 * will not name a canonical checkout.
 * @param {string} [root]
 * @returns {string | null}
 */
function gateRunLogPath(root) {
	const canonical = repoRoot(root);
	return canonical ? path.join(markersDir(canonical), GATE_RUN_LOG) : null;
}

/**
 * The repo a gate run is recorded under: its canonical checkout's directory
 * name, or null where git will not name one.
 * @param {string} [root]
 */
function gateRepoName(root) {
	const canonical = repoRoot(root);
	return canonical ? path.basename(canonical) : null;
}

/**
 * Append one gate run to the record. Never throws: an unwritable record
 * costs the line, never the commit.
 * @param {string | null} file
 * @param {GateRun} run
 * @returns {boolean} whether the line landed
 */
const appendGateRun = (file, run) =>
	appendRetained(file, run, GATE_RUN_RETAIN_MS);

/**
 * A waiting gate's position line: its place among the whole suites holding or
 * waiting for the slot, who holds it, and how long it has waited.
 * @param {{ position: number, holder: { repo?: string | null, session?: string | null, pid: number } | null, waitedS: number }} at
 */
function gatePositionLine({ position, holder, waitedS }) {
	const held = holder
		? `held by ${holder.repo ?? "an unknown repo"}, session ${holder.session ?? "none"} (pid ${holder.pid})`
		: "slot free";
	return `queue-run.js --gate: position ${position} for the whole-suite slot, ${held}, waited ${waitedS}s\n`;
}

/**
 * `pid`'s command line as `ps` prints it, or "" where it will not read.
 * @param {number} pid
 */
function readArgsOf(pid) {
	try {
		return fs
			.readFileSync(path.join(procRoot(), String(pid), "cmdline"), "utf8")
			.split("\0")
			.filter(Boolean)
			.join(" ");
	} catch {
		return "";
	}
}

/**
 * Whether an ancestor of `pid` is a suite runner the gate counts: a vitest
 * runner, or a non-vitest one (#330).
 * @param {{ pid?: number, parentOf?: (pid: number) => number, argsOf?: (pid: number) => string }} [options]
 */
function readInSuite({
	pid = process.pid,
	parentOf = readParentOf,
	argsOf = readArgsOf,
} = {}) {
	return readAncestorsOf(pid, { parentOf }).some((ancestor) => {
		const args = argsOf(ancestor);
		const words = args.split(" ").filter(Boolean);
		return (
			isVitestRunnerLine(args) ||
			(words.length > 0 && isOtherRunner(words, () => []))
		);
	});
}

module.exports = {
	GATE_ENV,
	GATE_ROLE,
	GATE_SEAT_DEFAULT_MB,
	GATE_RUN_LOG,
	GATE_RUN_RETAIN_MS,
	appendGateRun,
	gatePositionLine,
	gateRepoName,
	gateRunLogPath,
	gateSeatChargeMb,
	readInSuite,
};
