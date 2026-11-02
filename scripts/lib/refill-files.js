/*
 * refill-files.js — the refill loop's files, read and written (#2012, spec
 * #1995, #3392); what they hold, lib/refill-loop.js parses.
 *
 * ITS FILES, under lib/refill-dir.js's directory, so `start`, `stop` and `set`
 * never race the loop's own tick:
 *   - control, written by `start`, `stop`, `set`, the tick's away changes and the
 *     loop's own no-progress pause, each read and write under withControlLock, so
 *     no writer loses another's change;
 *   - state, written by the loop;
 *   - pidfile, created by the loop exclusively, so a second loop exits;
 *   - the review runner's pidfile and result (scripts/refill-review-run.js,
 *     #3765), written by the runner, the result removed by the tick that
 *     reads it.
 * `WFC_REFILL_DIR` moves them all, with the log, the stop-seen stamp
 * check-refill-loop-stop.js writes, and the code directory of worktrees the
 * loop runs from (lib/refill-code.js).
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { pidLock, waitForLock } = require("./pid-lock.js");
const { refillPath } = require("./refill-dir.js");
const { isRecord } = require("./refill-goal.js");
const { parseControl, parseState } = require("./refill-loop.js");

function loopFiles() {
	return {
		control: refillPath(".refill-loop-control.json"),
		state: refillPath(".refill-loop-state.json"),
		pid: refillPath(".refill-loop.pid"),
		log: refillPath(".refill-loop.log"),
		stopSeen: refillPath(".refill-loop-stop-seen"),
		overflowSeen: refillPath(".refill-overflow-seen"),
		wake: refillPath(".refill-loop-wake"),
		gates: refillPath(".refill-gate-readings.json"),
		code: refillPath(".refill-loop-code"),
		review: refillPath(".refill-review-result.json"),
		reviewPid: refillPath(".refill-review.pid"),
	};
}

/* The review runner, by the name its pidfile's holder runs (lib/pid-lock.js). */
const REVIEW_RUNNER = "refill-review-run.js";

/**
 * The file's read: `found` false where it is absent, else its parsed `value`,
 * or why it would not read or parse in `damage`.
 * @param {string} file
 * @returns {{found: boolean, value: unknown, damage: string|null}}
 */
function readJsonOutcome(file) {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		return { found: true, value, damage: null };
	} catch (err) {
		const { code, message } = caught(err);
		return code === "ENOENT"
			? { found: false, value: null, damage: null }
			: /* One line: JSON.parse's message can quote a multi-line source (#3814). */
				{ found: true, value: null, damage: message.replace(/\s*\n\s*/g, " ") };
	}
}

/**
 * The parsed file, or null where it is absent or damaged. A damaged file is a
 * fault, so `log` gets a line naming it and the error (#3380).
 * @param {string} file
 * @param {(line: string) => void} log
 * @returns {unknown}
 */
function readJson(file, log) {
	/* Fail open (#2012): each caller's parse reads null as its defaults, so a
	 * damaged file costs the remembered state rather than stopping the loop;
	 * the control alone stops it, through readControlChecked. */
	const { value, damage } = readJsonOutcome(file);
	if (damage !== null)
		log(
			`${file} is damaged (${damage}); read as absent, so its defaults stand until its next write replaces it`,
		);
	return value;
}

/**
 * @param {string} file
 * @param {unknown} value
 */
function writeJson(file, value) {
	writeFileAtomic(file, `${JSON.stringify(value, null, "\t")}\n`, {
		mkdir: true,
	});
}

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
			busy: `${file} is held by pid ${lock.holder() ?? "unknown"}; re-run once it finishes`,
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
 * The state file the loop writes, parsed; absent or damaged reads as parseState's
 * defaults, with `log` told of damage.
 * @param {(line: string) => void} log
 * @returns {import("./refill-loop.js").LoopState}
 */
const readStateFile = (log) => parseState(readJson(loopFiles().state, log));

/**
 * Record that the calling process holds the pidfile: the last stop no longer
 * describes the loop, and any death from here on is a crash (#3861).
 * @param {(line: string) => void} log
 */
function recordRunHeld(log) {
	const state = /** @type {object|null} */ (readJson(loopFiles().state, log));
	writeJson(loopFiles().state, { ...state, stopped: null, heldAt: Date.now() });
}

/**
 * Forget the last process's hold, before starting another: until the new one
 * holds the pidfile, no process has died (#3861). Called with none running, so
 * no tick's write can overtake it.
 * @param {(line: string) => void} log
 */
function forgetRunHeld(log) {
	const state = /** @type {object|null} */ (readJson(loopFiles().state, log));
	if (state) writeJson(loopFiles().state, { ...state, heldAt: null });
}

module.exports = {
	forgetRunHeld,
	recordRunHeld,
	loopFiles,
	REVIEW_RUNNER,
	readControlChecked,
	withControlLock,
	writeControlFile,
	writeLoopPause,
	readControlFile,
	readJson,
	readStateFile,
	writeJson,
};
