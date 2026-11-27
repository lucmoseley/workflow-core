const fs = require("node:fs");
const path = require("node:path");
const { readCurrentBootId } = require("./arbiter-proc.js");
const { pidLock, waitForLock } = require("./pid-lock.js");
const { CODE_DIR, PID_FILE } = require("./refill-control-code.js");
const { refillPath } = require("./refill-dir.js");
const { isRecord } = require("./refill-goal.js");
const { readJson, readJsonOutcome, writeJson } = require("./refill-json.js");
const { parseControl } = require("./refill-loop.js");

function loopFiles() {
	return {
		control: refillPath(".refill-loop-control.json"),
		pid: refillPath(PID_FILE),
		launch: refillPath(".refill-loop-launch.pid"),
		log: refillPath(".refill-loop.log"),
		stopSeen: refillPath(".refill-loop-stop-seen"),
		managerRestart: refillPath(".refill-loop-manager-restart.json"),
		overflowSeen: refillPath(".refill-overflow-seen"),
		wake: refillPath(".refill-loop-wake"),
		gates: refillPath(".refill-gate-readings.json"),
		code: refillPath(CODE_DIR),
		review: refillPath(".refill-review-result.json"),
		reviewPid: refillPath(".refill-review.pid"),
	};
}

/** @param {string} line */
const buildLoopLogLine = (line) => `${new Date().toISOString()} ${line}\n`;

/** @param {string} line */
function appendLoopLog(line) {
	const file = loopFiles().log;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, buildLoopLogLine(line));
}

const REVIEW_RUNNER = "refill-review-run.js";

/**
 * @param {(line: string) => void} log
 * @returns {import("./refill-loop.js").ControlRead}
 */
function readControlChecked(log) {
	const file = loopFiles().control;
	const { found, value, damage } = readJsonOutcome(file);
	const control = parseControl(value);
	const why =
		damage ??
		(found && control === null ? "not a control: not a JSON object" : null);
	if (why === null) {
		const rawGoal =
			isRecord(value) && isRecord(value.scope) ? value.scope.goal : null;
		if (rawGoal && control?.scope.goal === null)
			log(
				`${file}'s goal is garbled; the loop runs bare until a set replaces it`,
			);
		return { control, damaged: null };
	}
	const damaged = `${file} is damaged (${why})`;
	log(`${damaged}; the loop stops on it until a start rewrites it`);
	return { control: null, damaged };
}

/** @param {(line: string) => void} log */
const readControlFile = (log) => readControlChecked(log).control;

/** @param {import("./refill-loop.js").Control} control */
const writeControlFile = (control) => writeJson(loopFiles().control, control);

/**
 * @template T
 * @param {() => T} write
 * @param {number} [waitMs]
 * @returns {{done: T}|{busy: string}}
 */
function withControlLock(write, waitMs) {
	const file = `${loopFiles().control}.lock`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const lock = pidLock(file, "refill-loop.js");
	if (!waitForLock(lock, waitMs))
		return {
			busy: `${file} is held by pid ${lock.holder() ?? "unknown"}`,
		};
	try {
		return { done: write() };
	} finally {
		lock.release();
	}
}

/** @typedef {{bootId: string|null, at: number}} ManagerRestart */

/** @param {number} at */
const writeManagerRestart = (at) =>
	writeJson(loopFiles().managerRestart, { bootId: readCurrentBootId(), at });

/**
 * @param {(line: string) => void} log
 * @returns {ManagerRestart|null}
 */
const readManagerRestart = (log) =>
	/** @type {ManagerRestart|null} */ (
		readJson(loopFiles().managerRestart, log)
	);

/**
 * @param {ManagerRestart} read
 * @param {(line: string) => void} log
 */
function dropManagerRestart(read, log) {
	if (readManagerRestart(log)?.at === read.at)
		fs.rmSync(loopFiles().managerRestart, { force: true });
}

module.exports = {
	appendLoopLog,
	buildLoopLogLine,
	dropManagerRestart,
	readManagerRestart,
	writeManagerRestart,
	loopFiles,
	REVIEW_RUNNER,
	readControlChecked,
	withControlLock,
	writeControlFile,
	readControlFile,
};
