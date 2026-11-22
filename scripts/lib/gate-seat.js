const fs = require("node:fs");
const path = require("node:path");
const { readCurrentBootId } = require("./arbiter-proc.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");
const { parseJsonl } = require("./jsonl.js");
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

const GATE_ENV = "WFC_GATE_SEAT";
const GATE_ROLE = "gate";
const GATE_SEAT_DEFAULT_MB = suiteRungMb(WHOLE_SUITE_WORKERS);

const GATE_RUN_LOG = ".gate-runs.jsonl";

// guess, #5450
const GATE_PEAK_RUNS = 5;
// guess, #5450
const SHORT_GATE_MAX_S = 60;
const GATE_SELECTION_ENV = "WFC_GATE_SELECTION";

/** @typedef {"pass" | "red" | "ceiling" | "killed"} GateOutcome */
/**
 * @typedef {object} GateRun
 * @property {string} at
 * @property {string | null} repo
 * @property {string} tree
 * @property {string} command
 * @property {string | null} session
 * @property {number | null} ticket
 * @property {number} waitS
 * @property {number} runS
 * @property {number} [wallS]
 * @property {GateOutcome} outcome
 * @property {number} peakTreeMb
 * @property {true} [part]
 * @property {string} [selection]
 */

/** @param {{ gateSeatMb?: number } | null} config */
const gateSeatChargeMb = (config) => config?.gateSeatMb ?? GATE_SEAT_DEFAULT_MB;

/**
 * @param {string} [root]
 * @returns {string | null}
 */
function gateRunLogPath(root) {
	const canonical = repoRoot(root);
	return canonical ? path.join(markersDir(canonical), GATE_RUN_LOG) : null;
}

/** @param {string} [root] */
function gateRepoName(root) {
	const canonical = repoRoot(root);
	return canonical ? path.basename(canonical) : null;
}

/**
 * @param {string | null} file
 * @returns {GateRun[] | null}
 */
function readGateRunsAt(file) {
	if (file === null) return null;
	const read = readText(file);
	if (read.state === "absent") return [];
	return read.state === "read"
		? /** @type {GateRun[]} */ (parseJsonl(read.data).rows)
		: null;
}

/**
 * @param {GateRun[]} runs
 * @param {{ repo: string | null, command: string }} seat
 * @returns {{ peakMb: number, short: boolean } | null}
 */
function measuredGatePeak(runs, { repo, command }) {
	const last = runs
		.filter(
			(r) =>
				r.repo === repo &&
				r.command === command &&
				(r.outcome === "pass" || r.outcome === "red"),
		)
		.slice(-GATE_PEAK_RUNS);
	if (last.length < GATE_PEAK_RUNS) return null;
	if (!last.every((r) => r.peakTreeMb > 0)) return null;
	return {
		peakMb: Math.max(...last.map((r) => r.peakTreeMb)),
		short: last.every((r) => r.runS <= SHORT_GATE_MAX_S),
	};
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function readGateSelection(file) {
	const read = readText(file);
	if (read.state !== "read") return null;
	return (
		read.data
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean) ?? null
	);
}

/**
 * @param {string | null} file
 * @param {GateRun} run
 * @returns {boolean}
 */
const appendGateRun = (file, run) =>
	appendRetained(file, run, QUEUE_EXIT_RETAIN_MS);

/** @param {{ position: number | null, holder: { repo?: string | null, session?: string | null, pid: number } | null, waitedS: number, unread?: string }} at */
function gatePositionLine({ position, holder, waitedS, unread }) {
	if (position === null)
		return `queue-run.js --gate: place for the whole-suite slot unknown, the suite queue unread (${unread ?? "no reason given"}), waited ${waitedS}s\n`;
	const held = holder
		? `held by ${holder.repo ?? "an unknown repo"}, session ${holder.session ?? "none"} (pid ${holder.pid})`
		: "slot free";
	return `queue-run.js --gate: position ${position} for the whole-suite slot, ${held}, waited ${waitedS}s\n`;
}

/** @param {number} pid */
function readArgsOf(pid) {
	const read = readText(path.join(procRoot(), String(pid), "cmdline"));
	return read.state === "read"
		? read.data.split("\0").filter(Boolean).join(" ")
		: "";
}

/**
 * @param {number} pid
 * @returns {string[]}
 */
function readRunnersOf(pid) {
	try {
		const cwd = fs.readlinkSync(path.join(procRoot(), String(pid), "cwd"));
		const root = gitTopLevel(cwd, HOOK_GIT_TIMEOUT_MS);
		return readConfig({ root, quiet: true }).suiteRunners ?? [];
	} catch {
		return [];
	}
}

/** @param {{ pid?: number, parentOf?: (pid: number) => number, argsOf?: (pid: number) => string, runnersOf?: (pid: number) => string[] }} [options] */
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
 * @typedef {object} GatePids
 * @property {string} at
 * @property {string | null} bootId
 * @property {string | null} repo
 * @property {string} command
 * @property {string | null} session
 * @property {number} sampleMs
 * @property {string} sampledAt
 * @property {Record<string, string>} seenAt
 * @property {string} [endedAt]
 */

/**
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
	GATE_RUN_LOG,
	GATE_ROLE,
	GATE_SEAT_DEFAULT_MB,
	GATE_SELECTION_ENV,
	appendGateRun,
	gatePositionLine,
	gateRepoName,
	gateRunLogPath,
	gateHeldUntil,
	gateSeatChargeMb,
	isInSuite,
	measuredGatePeak,
	readGatePids,
	readGateRunsAt,
	readGateSelection,
	startGatePids,
};
