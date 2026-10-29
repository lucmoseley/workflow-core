/*
 * job-paths.js — the harness's job store layout, `<seat>/jobs/<jobId>/state.json`
 * (#2966), and its daemon's roster (#2986), built in one place.
 * A leaf: a per-prompt hook reads a job record through it, so it loads
 * nothing past node's own modules.
 */

const fs = require("node:fs");
const path = require("node:path");

/** @param {string} seat */
const jobStorePath = (seat) => path.join(seat, "jobs");

/**
 * @param {string} seat
 * @param {string} jobId
 */
const jobDirPath = (seat, jobId) => path.join(jobStorePath(seat), jobId);

/**
 * A job directory's record file; `jobDir` as `CLAUDE_JOB_DIR` gives it, or
 * jobDirPath's.
 * @param {string} jobDir
 */
const jobStateIn = (jobDir) => path.join(jobDir, "state.json");

/**
 * @param {string} seat
 * @param {string} jobId
 */
const jobStatePath = (seat, jobId) => jobStateIn(jobDirPath(seat, jobId));

/**
 * The seat and job id a job directory names, `CLAUDE_JOB_DIR` being
 * `<seat>/jobs/<jobId>`; null where `jobDir` is empty or not in that layout.
 * @param {string|undefined} jobDir
 * @returns {{seat: string, jobId: string}|null}
 */
function jobOfDir(jobDir) {
	if (!jobDir) return null;
	const dir = path.resolve(jobDir);
	const store = path.dirname(dir);
	if (path.basename(store) !== "jobs") return null;
	return { seat: path.dirname(store), jobId: path.basename(dir) };
}

/**
 * The daemon roster for `seat`'s job store (mantahostels#2049).
 * @param {string} seat
 */
const rosterPath = (seat) => path.join(seat, "daemon", "roster.json");

/**
 * The harness's short job id: the session id's first 8 characters, the name
 * of every `jobs/<id>` directory measured on this machine (#2954).
 * @param {string} sessionId
 */
const shortJobId = (sessionId) => sessionId.slice(0, 8);

/**
 * Job `jobId`'s parsed record on `seat`, or null where it is missing, torn or
 * refused. None of the three proves the job gone: a job dir is cleaned under a
 * session still running (mantahostels#104), and a writer may be mid-record.
 * @param {string} seat
 * @param {string} jobId
 * @returns {any}  untyped: the harness owns its schema
 */
function readJobRecord(seat, jobId) {
	try {
		return JSON.parse(fs.readFileSync(jobStatePath(seat, jobId), "utf8"));
	} catch {
		return null;
	}
}

module.exports = {
	jobDirPath,
	jobOfDir,
	jobStateIn,
	jobStatePath,
	jobStorePath,
	readJobRecord,
	rosterPath,
	shortJobId,
};
