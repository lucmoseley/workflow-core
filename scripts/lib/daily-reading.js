/*
 * daily-reading.js — the daily filing run a `report-*` filer launches at
 * session start (#1378, #3464): one reading a day behind periodic-reading.js's
 * gate, its stamp and lock in the git common dir, printing what the reading
 * did or why it was skipped.
 *
 * It fails open: a `gh` or git failure is one line in the arbiter's error
 * log, which `npm run check:guard-errors` reports, and one FAILED OPEN line on
 * stderr; the run still exits 0, and the next day's reading retries. A
 * session start never waits on, or fails for, a count nobody asked for
 * (#1378).
 */

const path = require("node:path");
const { logError } = require("./arbiter-core");
const { failureReason, now } = require("./check");
const { gitCommonDirOrThrow } = require("./git.js");
const { hostRoot } = require("./host-root");
const { buildSkipLine, periodicReading } = require("./periodic-reading");
const { writeFd } = require("./write-fd.js");

const DAY_MS = 24 * 3_600_000;

/**
 * @param {{ script: string, stamp: string, read: (nowMs: number) => string }}
 *   reading `script` is the filer's own path, whose basename the gate's lock
 *   holder carries and, less `.js`, names the run in the error log; `stamp`
 *   is the stamp's basename in the git common dir, its lock beside it with
 *   `.lock` added; `read` returns what it did, to print
 */
function runDailyReading({ script, stamp, read }) {
	const where = path.basename(script, ".js");
	const lock = `${stamp}.lock`;
	try {
		const nowMs = now();
		const dir = gitCommonDirOrThrow(hostRoot());
		const gate = periodicReading(
			{
				stamp: path.join(dir, stamp),
				lock: path.join(dir, lock),
				script: path.basename(script),
				nowMs,
				everyMs: DAY_MS,
			},
			() => read(nowMs),
		);
		writeFd(1, `${gate.ran ? gate.value : buildSkipLine(gate, "a day")}\n`);
	} catch (e) {
		logError(where, e);
		writeFd(
			2,
			`FAILED OPEN: ${failureReason(e)} — recorded in the guard-error log; the next day's reading retries.\n`,
		);
	}
}

module.exports = { runDailyReading };
