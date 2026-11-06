/*
 * launch-record.js — the one reader of a refill launch's job record (#4587),
 * whichever route launched it: a launch on an overflow key reads its headless
 * run (lib/headless-runs.js's readRunAsJob), a plan launch its `--bg` job's
 * state.json. Both give one shape, so the refill loop never picks a reader by
 * route.
 */

const { buildErrorText } = require("./caught.js");

/**
 * A launch's job record. A `--bg` job's state.json is the harness's own
 * schema, so its fields are unknown until checked.
 * @typedef {{sessionId?: unknown, cwd?: unknown, state?: unknown,
 *   detail?: unknown, linkScanPath?: unknown}} LaunchRecord
 */

/**
 * `read()`'s value, or null where it throws, logged as `what` unread.
 * @template T
 * @param {(line: string) => void} log
 * @param {string} what
 * @param {() => T} read
 * @returns {T|null}
 */
function readLogged(log, what, read) {
	try {
		return read();
	} catch (e) {
		log(`${what} unread: ${buildErrorText(e)}`);
		return null;
	}
}

/**
 * The reader of a launch's job record over the two route reads: null where
 * the launch has no job or none reads, a headless record that throws logged.
 * @param {{
 *   log: (line: string) => void,
 *   readJobRecord: (seat: string, jobId: string) => LaunchRecord|null,
 *   readRunAsJob: (jobId: string) => LaunchRecord|null,
 * }} io
 * @returns {(l: {seat: string, keyVar?: string, jobId?: string|null}) =>
 *   LaunchRecord|null}
 */
const launchRecordReader =
	({ log, readJobRecord, readRunAsJob }) =>
	({ seat, keyVar, jobId }) => {
		if (!jobId) return null;
		if (!keyVar) return readJobRecord(seat, jobId);
		return readLogged(log, `headless run ${jobId}`, () => readRunAsJob(jobId));
	};

module.exports = { launchRecordReader, readLogged };
