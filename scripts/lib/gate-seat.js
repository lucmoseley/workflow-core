/*
 * gate-seat.js — the gate seat (workflow-core#5274, spec workflow-core#5273 §1-§2): the suite-queue
 * hold one gate run takes, a gate run being one run of a repo's declared test
 * command for one commit's verdict, however many runner processes it starts
 * (.claude/workflow-core.glossary.md).
 *
 * THE SEAT IS THE WHOLE-SUITE SLOT. `queue-run.js --gate` joins the suite
 * queue's FIFO as a whole suite, marked role `gate`, and hands its command the
 * marker's path in GATE_ENV. The marker carries the holder pid, the repo, the
 * session and the command, and the seat's charge in `chargeMb`.
 *
 * THE ANCESTRY IS THE TEST, never the variable (lib/suite-queue.js
 * `readGateSeats`): a runner the seat's command starts counts as the seat,
 * and one outside the seat's process tree that inherited the variable counts
 * as itself.
 *
 * THE CHARGE is the repo's `gateSeatMb`, set by hand to the highest
 * `peakTreeMb` on its gate-run record, else the whole-suite rung. Admission
 * holds it while a seat is queued or running, less what the seat's processes
 * already draw (lib/admission.js `gateSeatHeldMb`).
 *
 * THE GATE-RUN RECORD is `.gate-runs.jsonl` under the canonical checkout's
 * markers directory, one line per gate run, kept as long as the queue-exit
 * log (lib/queue-exit-log.js `QUEUE_EXIT_RETAIN_MS`). It is the
 * one source of gate-run counts.
 *
 * THE PID RECORD names the processes of a running seat's tree for the
 * memory-kill filer (workflow-core#5269): one file a seat in lib/run-memory.js's store,
 * GATE_FILE_PREFIX-named. A pid is the seat's only up to `gateHeldUntil`, so
 * a pid reused after it is never named the seat's. A process
 * that starts and dies between two samples goes unrecorded.
 *
 * A GATE INSIDE A RUNNING SUITE'S PROCESS TREE takes no seat: a test
 * committing in a fixture repo runs in the slot and on the rung its suite
 * already holds, and would otherwise wait on that suite for good. It still
 * runs under the ceiling and is recorded. A runner ancestor's declared
 * `suiteRunners` are read from that ancestor's own checkout, the git top
 * level of its cwd, never the host: the pre-commit hook repoints
 * CLAUDE_PROJECT_DIR at the repo the commit is in (workflow-core#3307), a fixture's when
 * the suite is the host's (workflow-core#5303). A runner whose cwd is outside its own
 * checkout goes unread, and its gate takes a seat.
 */

const fs = require("node:fs");
const path = require("node:path");
const { readCurrentBootId } = require("./arbiter-proc.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");
const { HOOK_GIT_TIMEOUT_MS } = require("./git.js");
const { gitTopLevel } = require("./host-root.js");
const { readConfig } = require("./workflow-core-config.js");
const { readAncestorsOf, readParentOf } = require("./proc-stat.js");
const { procRoot } = require("./proc-root.js");
const { isOtherRunner } = require("./suite-launch.js");
const { markersDir } = require("./marker-root.js");
const { QUEUE_EXIT_RETAIN_MS } = require("./queue-exit-log.js");
const { appendRetained } = require("./retained-jsonl.js");
const { repoRoot } = require("./test-pass-marker.js");
const { WHOLE_SUITE_WORKERS } = require("./suite-bounded.js");
const { isVitestRunnerLine, suiteRungMb } = require("./suite-ladder.js");
const {
	GATE_FILE_PREFIX,
	holdsObject,
	readStoreFiles,
	seenUntil,
	storeDir,
	sweep,
} = require("./run-memory.js");

/* The variable a gate seat hands its command, naming its marker. */
const GATE_ENV = "WFC_GATE_SEAT";
/* The marker role admission reads the seat by, as it reads the lander's. */
const GATE_ROLE = "gate";
/* A repo declaring no `gateSeatMb` is charged the whole-suite rung, 3,350 MB:
 * unmeasured for a non-vitest runner, and never under-charging one. */
const GATE_SEAT_DEFAULT_MB = suiteRungMb(WHOLE_SUITE_WORKERS);

const GATE_RUN_LOG = ".gate-runs.jsonl";

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
	appendRetained(file, run, QUEUE_EXIT_RETAIN_MS);

/**
 * A waiting gate's position line: its place among the whole suites holding or
 * waiting for the slot, who holds it, and how long it has waited. A queue
 * that would not read leaves the place unknown, and the line says why
 * (workflow-core#5274).
 * @param {{ position: number | null, holder: { repo?: string | null, session?: string | null, pid: number } | null, waitedS: number, unread?: string }} at
 */
function gatePositionLine({ position, holder, waitedS, unread }) {
	if (position === null)
		return `queue-run.js --gate: place for the whole-suite slot unknown, the suite queue unread (${unread ?? "no reason given"}), waited ${waitedS}s\n`;
	const held = holder
		? `held by ${holder.repo ?? "an unknown repo"}, session ${holder.session ?? "none"} (pid ${holder.pid})`
		: "slot free";
	return `queue-run.js --gate: position ${position} for the whole-suite slot, ${held}, waited ${waitedS}s\n`;
}

/**
 * `pid`'s command line off `/proc/<pid>/cmdline`, its words joined by spaces,
 * or "" where it is absent or will not read: a process that has exited, or
 * another user's, is no suite runner the gate seat can sit inside.
 * @param {number} pid
 */
function readArgsOf(pid) {
	const read = readText(path.join(procRoot(), String(pid), "cmdline"));
	return read.state === "read"
		? read.data.split("\0").filter(Boolean).join(" ")
		: "";
}

/**
 * The `suiteRunners` `pid`'s own checkout declares: the config at the git top
 * level of its `/proc/<pid>/cwd`. None where the cwd, the checkout or the
 * config will not read.
 * @param {number} pid
 * @returns {string[]}
 */
function readRunnersOf(pid) {
	try {
		const cwd = fs.readlinkSync(path.join(procRoot(), String(pid), "cwd"));
		/* A guess, borrowed: the hooks' git ceiling, where `rev-parse` answers
		 * in milliseconds and a wedged one would hold the commit. */
		const root = gitTopLevel(cwd, HOOK_GIT_TIMEOUT_MS);
		return readConfig({ root, quiet: true }).suiteRunners ?? [];
	} catch {
		/* Residual: a runner whose checkout or config will not read declares
		 * none, and its gate takes a seat (workflow-core#5303). */
		return [];
	}
}

/**
 * Whether an ancestor of `pid` is a suite runner the gate counts: a vitest
 * runner, or a non-vitest one (workflow-core#330).
 * @param {{ pid?: number, parentOf?: (pid: number) => number, argsOf?: (pid: number) => string, runnersOf?: (pid: number) => string[] }} [options]
 */
function isInSuite({
	pid = process.pid,
	parentOf = readParentOf,
	argsOf = readArgsOf,
	runnersOf = readRunnersOf,
} = {}) {
	return readAncestorsOf(pid, { parentOf }).some((ancestor) => {
		const args = argsOf(ancestor);
		const words = args.split(" ").filter(Boolean);
		return (
			isVitestRunnerLine(args) ||
			(words.length > 0 && isOtherRunner(words, () => runnersOf(ancestor)))
		);
	});
}

/**
 * @typedef {object} GatePids one gate seat's pid record
 * @property {string} at the seat's command spawned, ISO
 * @property {string | null} bootId
 * @property {string | null} repo
 * @property {string} command
 * @property {string | null} session
 * @property {number} sampleMs the tree sample's interval
 * @property {string} sampledAt
 * @property {Record<string, string>} seenAt each pid's last sighting, ISO
 * @property {string} [endedAt]
 */

/**
 * Start a gate seat's pid record, written at once with no pid, then at each
 * `see`. Never throws (workflow-core#5269): an unwritable record costs the kill filer its
 * join, never the gate run, and `stop` answers the first write's failure for
 * the caller to print.
 * @param {{ repo: string | null, command: string, session: string | null }} holder
 * @param {{ sampleMs: number, pid?: number, dir?: string, now?: () => number,
 *   bootId?: string | null }} options
 * @returns {{ file: string, see: (pids: number[]) => void,
 *   stop: () => string | null }}
 */
function startGatePids(
	{ repo, command, session },
	{
		sampleMs,
		pid = process.pid,
		dir = storeDir(),
		now = Date.now,
		bootId = readCurrentBootId(),
	},
) {
	const startedAt = now();
	sweep(dir, startedAt);
	const file = path.join(dir, `${GATE_FILE_PREFIX}${pid}-${startedAt}.json`);
	const stamp = () => new Date(now()).toISOString();
	/** @type {GatePids} */
	const record = {
		at: new Date(startedAt).toISOString(),
		bootId,
		repo,
		command,
		session,
		sampleMs,
		sampledAt: stamp(),
		seenAt: {},
	};
	/** @type {string | null} */
	let unwritten = null;
	const write = () => {
		try {
			writeFileAtomic(file, `${JSON.stringify(record)}\n`, { mkdir: true });
		} catch (e) {
			unwritten ??= caught(e).message;
		}
	};
	write();
	return {
		file,
		see: (pids) => {
			const at = stamp();
			for (const seen of pids) record.seenAt[seen] = at;
			record.sampledAt = at;
			write();
		},
		stop: () => {
			record.endedAt = stamp();
			write();
			return unwritten;
		},
	};
}

/**
 * Every gate seat's pid record in the store, or why the store would not read.
 * @param {string} [dir]
 * @returns {{ seats: GatePids[], why: string | null }}
 */
function readGatePids(dir = storeDir()) {
	/** @type {{ items: GatePids[], why: string | null }} */
	const { items, why } = readStoreFiles({
		dir,
		named: (name) => name.startsWith(GATE_FILE_PREFIX),
		shaped: (seat) => holdsObject(seat, "seenAt"),
	});
	return { seats: items, why };
}

/**
 * The last time, ms, `pid` can be taken for `seat`'s (lib/run-memory.js
 * `seenUntil`); null where the seat never saw it.
 * @param {GatePids} seat
 * @param {number} pid
 * @returns {number | null}
 */
function gateHeldUntil(seat, pid) {
	const seen = seat.seenAt[pid];
	if (!seen) return null;
	return seenUntil(
		Date.parse(seen),
		Date.parse(seat.endedAt ?? seat.sampledAt),
		seat.sampleMs,
	);
}

module.exports = {
	GATE_ENV,
	GATE_ROLE,
	GATE_SEAT_DEFAULT_MB,
	appendGateRun,
	gatePositionLine,
	gateRepoName,
	gateRunLogPath,
	gateHeldUntil,
	gateSeatChargeMb,
	isInSuite,
	readGatePids,
	startGatePids,
};
