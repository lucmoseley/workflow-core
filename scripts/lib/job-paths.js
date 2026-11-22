const path = require("node:path");
const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
const readJobDir = (env) => env.CLAUDE_JOB_DIR || null;

/** @param {NodeJS.ProcessEnv} env */
const isBackgroundJob = (env) => readJobDir(env) !== null;

/** @param {string} seat */
const jobStorePath = (seat) => path.join(seat, "jobs");

/**
 * @param {string} seat
 * @param {string} jobId
 */
const jobDirPath = (seat, jobId) => path.join(jobStorePath(seat), jobId);

/**
 * @param {string} jobDir
 */
const jobStateIn = (jobDir) => path.join(jobDir, "state.json");

/**
 * @param {string} seat
 * @param {string} jobId
 */
const jobStatePath = (seat, jobId) => jobStateIn(jobDirPath(seat, jobId));

/**
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
 * @param {string} seat
 */
const rosterPath = (seat) => path.join(seat, "daemon", "roster.json");

// measured 8-character jobs/<id> names, #2954
/** @param {string} sessionId */
const shortJobId = (sessionId) => sessionId.slice(0, 8);

// #4704
const ABSENT = new Set(["ENOENT", "ENOTDIR"]);

/** @param {unknown} err */
const isAbsentFault = (err) => ABSENT.has(caught(err).code ?? "");

/**
 * @param {string} jobDir
 * @returns {{state: "absent"} | {state: "read", data: any}
 *   | {state: "unreadable", error: unknown, message: string}}
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
 * @param {string} jobDir
 * @returns {any}
 */
function readJobRecordIn(jobDir) {
	const r = readJobRecordAt(jobDir);
	if (r.state === "unreadable") throw r.error;
	return r.state === "read" ? r.data : null;
}

/**
 * @param {string} seat
 * @param {string} jobId
 * @returns {any}
 */
const readJobRecord = (seat, jobId) => readJobRecordIn(jobDirPath(seat, jobId));

/**
 * @param {string} seat
 * @param {string} jobId
 * @returns {string|null}
 */
function readJobCwd(seat, jobId) {
	const cwd = readJobRecord(seat, jobId)?.cwd;
	return typeof cwd === "string" ? cwd : null;
}

module.exports = {
	isBackgroundJob,
	jobDirPath,
	parseJobDir,
	readJobDir,
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
