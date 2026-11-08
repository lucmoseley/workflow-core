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
 * @param {{ where: string, stamp: string, lock: string, script: string,
 *   read: (nowMs: number) => string }} reading `where` names the run in the
 *   error log; `stamp` and `lock` are basenames in the git common dir;
 *   `script` is the filer's basename; `read` returns what it did, to print
 */
function runDailyReading({ where, stamp, lock, script, read }) {
	try {
		const nowMs = now();
		const dir = gitCommonDirOrThrow(hostRoot());
		const gate = periodicReading(
			{
				stamp: path.join(dir, stamp),
				lock: path.join(dir, lock),
				script,
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
