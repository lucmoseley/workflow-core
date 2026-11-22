const { readLogged } = require("./caught.js");

/**
 * @typedef {{sessionId?: unknown, cwd?: unknown, state?: unknown,
 *   detail?: unknown, linkScanPath?: unknown, respawnFlags?: unknown}}
 *   LaunchRecord
 */

/**
 * @param {{
 *   log: (line: string) => void,
 *   readJobRecord: (seat: string, jobId: string) => LaunchRecord|null,
 *   readRunAsJob: (jobId: string) => LaunchRecord|null,
 * }} io
 * @returns {(l: {seat: string, keyVar?: string, jobId?: string|null}) =>
 *   LaunchRecord|null}
 */
const buildLaunchRecordReader =
	({ log, readJobRecord, readRunAsJob }) =>
	({ seat, keyVar, jobId }) => {
		if (!jobId) return null;
		if (!keyVar) return readJobRecord(seat, jobId);
		return readLogged(log, `headless run ${jobId}`, () => readRunAsJob(jobId));
	};

module.exports = { buildLaunchRecordReader };
