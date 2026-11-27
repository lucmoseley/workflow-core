const path = require("node:path");
const { logError } = require("./arbiter-core");
const { failureReason, now } = require("./check");
const { gitCommonDirOrThrow } = require("./git.js");
const { hostRoot } = require("./host-root");
const { buildSkipLine, periodicReading } = require("./periodic-reading");
const { writeFd } = require("./write-fd.js");

const DAY_MS = 24 * 3_600_000;

/**
 * @param {{ script: string, stamp: string, read: (nowMs: number) => string }} reading
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
