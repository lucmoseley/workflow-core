/*
 * refill-files.js — the refill loop's files, read and written (#2012, spec
 * #1995, #3392); what they hold, lib/refill-loop.js parses.
 *
 * ITS FILES, under lib/refill-dir.js's directory, so `start`, `stop` and `set`
 * never race the loop's own tick:
 *   - control, written by `start`, `stop`, `set`, the tick's away changes and the
 *     loop's own no-progress pause, each read and write under withControlLock, so
 *     no writer loses another's change;
 *   - pidfile, created by the loop exclusively, so a second loop exits;
 *   - the launch's pidfile (#4139), held by a process spawning the loop, which
 *     `watch` reads so as to stand down;
 *   - the review runner's pidfile and result (scripts/refill-review-run.js,
 *     #3765), written by the runner, the result removed by the tick that
 *     reads it;
 *   - the manager-restart marker (#3971), written by `boot-resume` for a loop
 *     still running, removed by the tick that records it.
 * `WFC_REFILL_DIR` moves them all, with the log, the stop-seen stamp
 * check-refill-loop-stop.js writes, and the code directory of worktrees the
 * loop runs from (lib/refill-code.js).
 */

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

/* The review runner, by the name its pidfile's holder runs (lib/pid-lock.js). */
const REVIEW_RUNNER = "refill-review-run.js";

/**
 * The control file, parsed, and why where it exists
 * but is not one. A damaged control is no loop nobody started: the tick stops
 * on it under its own reason (#3389).
 * @param {(line: string) => void} log
 * @returns {import("./refill-loop.js").ControlRead}
 */
function readControlChecked(log) {
	const file = loopFiles().control;
	const { found, value, damage } = readJsonOutcome(file);
	const control = parseControl(value);
	const why =
		damage ??
		(found && control === null ? "not a control: no noProgressFrom" : null);
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
 * Run `write`, a control writer's read and write, under the one control lock,
 * a holder's being any `refill-loop.js` process; a dead holder's is taken over.
 * Residual: a `start` or `stop` that outlasts the wait writes nothing, so its
 * caller must re-run it (#3856).
 * @template T
 * @param {() => T} write
 * @param {number} [waitMs] the wait, in place of waitForLock's default
 * @returns {{done: T}|{busy: string}} `busy`, why, where a live holder kept the
 *   lock past the wait
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

/**
 * Write the no-progress pause the tick decided, against a fresh read: a pause
 * set since keeps its record, and a resume since moved the count this one rests
 * on. A lock kept past the wait writes nothing, and the next tick decides the
 * pause again.
 * @param {import("./refill-decide.js").Pause} paused
 * @param {number} noProgressFrom the count the tick decided it on
 * @param {(line: string) => void} log
 * @param {number} [waitMs] withControlLock's
 */
function writeLoopPause(paused, noProgressFrom, log, waitMs) {
	const written = withControlLock(() => {
		const { control } = readControlChecked(log);
		if (
			control === null ||
			control.paused !== undefined ||
			control.noProgressFrom !== noProgressFrom
		)
			return;
		writeControlFile({ ...control, paused });
	}, waitMs);
	if ("busy" in written)
		log(
			`pause not written, so the next tick decides it again: ${written.busy}`,
		);
}

/**
 * @typedef {{bootId: string|null, at: number}} ManagerRestart  what `boot-resume`
 *   leaves a loop that survived the user manager's restart, its own file as that
 *   loop's tick would overwrite a change to the state (#3971)
 */

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
 * Remove the marker `read` once the state records it, unless a later restart has
 * replaced it since.
 * @param {ManagerRestart} read
 * @param {(line: string) => void} log
 */
function dropManagerRestart(read, log) {
	if (readManagerRestart(log)?.at === read.at)
		fs.rmSync(loopFiles().managerRestart, { force: true });
}

module.exports = {
	dropManagerRestart,
	readManagerRestart,
	writeManagerRestart,
	loopFiles,
	REVIEW_RUNNER,
	readControlChecked,
	withControlLock,
	writeControlFile,
	writeLoopPause,
	readControlFile,
};
