/*
 * launch-record.js — the one reader of a refill launch's job record (#4587),
 * whichever route launched it: a launch on an overflow key reads its headless
 * run, a plan launch its `--bg` job.
 */

const { readLogged } = require("./caught.js");

/**
 * A launch's job record. A `--bg` job's state.json is the harness's own
 * schema.
 * @typedef {{sessionId?: unknown, cwd?: unknown, state?: unknown,
 *   detail?: unknown, linkScanPath?: unknown}} LaunchRecord
 */

/**
 * The reader of a launch's job record: null where
 * the launch has no job or none reads, a headless record that throws logged.
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
