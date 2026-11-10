/*
 * job-paths.js — the harness's job store layout, `<seat>/jobs/<jobId>/state.json`
 * (workflow-core#2966), and its daemon's roster (workflow-core#2986), built in one place.
 * A leaf: a per-prompt hook reads a job record through it, so it loads
 * nothing past node's own modules but file-read.js and its caught.js.
 */

const path = require("node:path");
const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");

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
function parseJobDir(jobDir) {
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
 * of every `jobs/<id>` directory measured on this machine (workflow-core#2954).
 * @param {string} sessionId
 */
const shortJobId = (sessionId) => sessionId.slice(0, 8);

/* The read faults that mean no record stands there: ENOTDIR where a job
 * store holds a plain file in place of a job directory (workflow-core#4704). */
const ABSENT = new Set(["ENOENT", "ENOTDIR"]);

/** @param {unknown} err */
const isAbsentFault = (err) => ABSENT.has(caught(err).code ?? "");

/**
 * The record in `jobDir`, `data` null where torn; unreadable is any fault
 * but absence (workflow-core#4704).
 * Neither absent nor torn proves the job gone: a job dir is cleaned under a
 * session still running (mantahostels#104), and a writer may be mid-record.
 * @param {string} jobDir
 * @returns {{state: "absent"} | {state: "read", data: any}
 *   | {state: "unreadable", error: unknown, message: string}}  `data`
 *   untyped: the harness owns its schema
 */
function readJobRecordAt(jobDir) {
	const r = readText(jobStateIn(jobDir));
	if (r.state === "absent") return r;
	if (r.state === "unreadable")
		return isAbsentFault(r.error) ? { state: "absent" } : r;
	try {
		return { state: "read", data: JSON.parse(r.data) };
	} catch {
		return { state: "read", data: null };
	}
}

/**
 * The parsed record in `jobDir`, or null where readJobRecordAt finds it
 * absent or torn; an unreadable one throws its fault.
 * @param {string} jobDir
 * @returns {any}
 */
function readJobRecordIn(jobDir) {
	const r = readJobRecordAt(jobDir);
	if (r.state === "unreadable") throw r.error;
	return r.state === "read" ? r.data : null;
}

/**
 * Job `jobId`'s record on `seat`, as readJobRecordIn reads it.
 * @param {string} seat
 * @param {string} jobId
 * @returns {any}
 */
const readJobRecord = (seat, jobId) => readJobRecordIn(jobDirPath(seat, jobId));

/**
 * The cwd job `jobId`'s record on `seat` names, null where it names none.
 * @param {string} seat
 * @param {string} jobId
 * @returns {string|null}
 */
function readJobCwd(seat, jobId) {
	const cwd = readJobRecord(seat, jobId)?.cwd;
	return typeof cwd === "string" ? cwd : null;
}

module.exports = {
	jobDirPath,
	parseJobDir,
	jobStateIn,
	jobStatePath,
	isAbsentFault,
	jobStorePath,
	readJobCwd,
	readJobRecord,
	readJobRecordAt,
	readJobRecordIn,
	rosterPath,
	shortJobId,
};
