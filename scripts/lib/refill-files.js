/*
 * refill-files.js — the refill loop's files, read and written (#2012, spec
 * #1995, #3392); what they hold, lib/refill-loop.js parses.
 *
 * ITS FILES, under lib/refill-dir.js's directory, so `start`, `stop` and `set`
 * never race the loop's own tick:
 *   - control, written by `start`, `stop` and `set`, each read and write under
 *     withControlLock, so no writer loses another's change;
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
 * The control file `start` and `stop` write, parsed, and why where it exists
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
	if (why === null) return { control, damaged: null };
	const damaged = `${file} is damaged (${why})`;
	log(`${damaged}; the loop stops on it until a start rewrites it`);
	return { control: null, damaged };
}

/** @param {(line: string) => void} log */
const readControlFile = (log) => readControlChecked(log).control;

/**
 * Write the control. `startedAt` repeats noProgressFrom for a running loop on
 * code from before #3854, which reads a control without it as damaged and stops,
 * until it adopts this code. A stopgap: #3888 removes it.
 * @param {import("./refill-loop.js").Control} control
 */
const writeControlFile = (control) =>
	writeJson(loopFiles().control, {
		startedAt: control.noProgressFrom,
		...control,
	});

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
 * The state file the loop writes, parsed; absent or damaged reads as parseState's
 * defaults, with `log` told of damage.
 * @param {(line: string) => void} log
 * @returns {import("./refill-loop.js").LoopState}
 */
const readStateFile = (log) => parseState(readJson(loopFiles().state, log));

module.exports = {
	loopFiles,
	REVIEW_RUNNER,
	readControlChecked,
	withControlLock,
	writeControlFile,
	readControlFile,
	readJson,
	readStateFile,
	writeJson,
};
