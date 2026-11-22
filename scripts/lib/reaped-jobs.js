const { refillPath } = require("./refill-dir.js");
const { caught } = require("./caught.js");
const { readJson, readJsonOutcome, writeJson } = require("./refill-json.js");

const REAPED_FILE = ".reaped-jobs.json";
const REAPED_READ_FILE = ".refill-reaped-read.json";

// guess, #5331
const REAPED_KEEP_MS = 24 * 60 * 60_000;

/**
 * @typedef {{at: number, seat: string, jobId: string, sessionId: string,
 *   name: string, cwd: string}} ReapedJob
 */

/** @param {unknown} e @returns {e is ReapedJob} */
const isEntry = (e) =>
	typeof e === "object" &&
	e !== null &&
	typeof (/** @type {ReapedJob} */ (e).at) === "number" &&
	["seat", "jobId", "sessionId", "name", "cwd"].every(
		(k) => typeof (/** @type {Record<string, unknown>} */ (e)[k]) === "string",
	);

/**
 * @param {unknown[]} list
 * @param {import("./agent-liveness.js").AgentRecord[]} stopped
 * @param {number} at
 * @returns {ReapedJob[]}
 */
function withReaped(list, stopped, at) {
	const kept = list.filter(isEntry).filter((e) => at - e.at < REAPED_KEEP_MS);
	const added = stopped.flatMap((a) =>
		a.seat && a.id && a.sessionId && a.cwd
			? [
					{
						at,
						seat: a.seat,
						jobId: a.id,
						sessionId: a.sessionId,
						name: a.name ?? a.id,
						cwd: a.cwd,
					},
				]
			: [],
	);
	return [...kept, ...added];
}

/** @returns {ReapedJob[]} */
function readReapedJobs() {
	const { value } = readJsonOutcome(refillPath(REAPED_FILE));
	return Array.isArray(value) ? value.filter(isEntry) : [];
}

/**
 * @param {import("./agent-liveness.js").AgentRecord[]} stopped
 * @param {number} at
 * @returns {string|null}
 */
function journalReapedJobs(stopped, at) {
	if (stopped.length === 0) return null;
	try {
		writeJson(
			refillPath(REAPED_FILE),
			withReaped(readReapedJobs(), stopped, at),
		);
		return null;
	} catch (err) {
		return caught(err).message;
	}
}

/** @param {ReapedJob} j */
const reapedKey = (j) => `${j.seat}\0${j.jobId}\0${j.at}`;

/** @param {(line: string) => void} log */
function readReaped(log) {
	const raw = readJson(refillPath(REAPED_READ_FILE), log);
	const read = Array.isArray(raw)
		? raw.filter((k) => typeof k === "string")
		: [];
	return { jobs: readReapedJobs(), read };
}

/** @param {string[]} keys */
const writeReapedRead = (keys) => writeJson(refillPath(REAPED_READ_FILE), keys);

module.exports = {
	REAPED_KEEP_MS,
	journalReapedJobs,
	readReaped,
	reapedKey,
	writeReapedRead,
};
