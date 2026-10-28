/*
 * refill-files.js — the refill loop's files, read and written (#2012, spec
 * #1995, #3392); what they hold, lib/refill-loop.js parses.
 *
 * THREE FILES, ONE WRITER EACH, under lib/refill-dir.js's directory, so
 * `start` and `stop` never race the loop's own tick:
 *   - control, written by `start` and `stop`;
 *   - state, written by the loop;
 *   - pidfile, created by the loop exclusively, so a second loop exits.
 * `WFC_REFILL_DIR` moves all three, with the log, the stop-seen stamp
 * check-refill-loop-stop.js writes, and the code directory of worktrees the
 * loop runs from (lib/refill-code.js).
 */

const fs = require("node:fs");
const { caught } = require("./caught.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { refillPath } = require("./refill-dir.js");
const { parseControl } = require("./refill-loop.js");

function loopFiles() {
	return {
		control: refillPath(".refill-loop-control.json"),
		state: refillPath(".refill-loop-state.json"),
		pid: refillPath(".refill-loop.pid"),
		log: refillPath(".refill-loop.log"),
		stopSeen: refillPath(".refill-loop-stop-seen"),
		wake: refillPath(".refill-loop-wake"),
		gates: refillPath(".refill-gate-readings.json"),
		code: refillPath(".refill-loop-code"),
	};
}

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
			: { found: true, value: null, damage: message };
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
		(found && control === null ? "not a control: no startedAt" : null);
	if (why === null) return { control, damaged: null };
	const damaged = `${file} is damaged (${why})`;
	log(`${damaged}; the loop stops on it until a start rewrites it`);
	return { control: null, damaged };
}

/** @param {(line: string) => void} log */
const readControlFile = (log) => readControlChecked(log).control;

module.exports = {
	loopFiles,
	readControlChecked,
	readControlFile,
	readJson,
	writeJson,
};
