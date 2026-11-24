const fs = require("node:fs");
const { configDirs } = require("./arbiter-store");
const { caught } = require("./caught.js");
const headless = require("./headless-runs.js");
const { jobDirPath, readJobRecordAt, shortJobId } = require("./job-paths.js");
const { buildSeatEnv, runClaude } = require("./seat-claude.js");

/**
 * @typedef {{ok: true, said: string}
 *   | {ok: false, why: string, said: string|null, timedOut: boolean,
 *      noJob: boolean}} StopOutcome
 */

// workflow-core#5329
const NO_JOB_ANSWER = /No (?:job|session) matching/;

// guess, workflow-core#5529
const STOP_TIMEOUT_MS = 15_000;

/**
 * @param {string} sessionId
 * @param {{jobId?: string, seats?: string[]}} [where]
 * @returns {{seat: string, job: any} | null}
 */
function readOwnJob(
	sessionId,
	{ jobId = shortJobId(sessionId), seats = configDirs() } = {},
) {
	for (const seat of seats) {
		const r = readJobRecordAt(jobDirPath(seat, jobId));
		const job = r.state === "read" ? r.data : null;
		if (job?.sessionId === sessionId) return { seat, job };
	}
	return null;
}

/**
 * @param {string} jobId
 * @param {string} sessionId
 * @returns {string[]}
 */
function readSeatsFor(jobId, sessionId) {
	/** @type {string[]} */
	const named = [];
	/** @type {string[]} */
	const unknown = [];
	for (const seat of configDirs()) {
		if (!fs.existsSync(seat)) continue;
		const r = readJobRecordAt(jobDirPath(seat, jobId));
		const owner = r.state === "read" ? r.data?.sessionId : undefined;
		if (owner === sessionId) named.push(seat);
		else if (typeof owner !== "string" || !owner) unknown.push(seat);
	}
	return [...named, ...unknown];
}

/**
 * @param {string} id
 * @param {string} sessionId
 * @returns {StopOutcome}
 */
function stopSession(id, sessionId) {
	const run = stopHeadless(id);
	if (run) return run;
	const seats = readSeatsFor(id, sessionId);
	/** @type {Extract<StopOutcome, {ok: false}>|undefined} */
	let firstRefusal;
	for (const seat of seats) {
		const r = stopOn(seat, id);
		if (r.ok || !r.noJob) return r;
		firstRefusal ??= r;
	}
	if (!firstRefusal)
		return {
			ok: false,
			why: `every seat's record of ${id} names another session`,
			said: null,
			timedOut: false,
			noJob: false,
		};
	return seats.length > 1
		? {
				...firstRefusal,
				why: `${firstRefusal.why} (on all ${seats.length} seats)`,
			}
		: firstRefusal;
}

/**
 * @param {string} seat
 * @param {string} id
 * @param {string} [bin]
 * @param {{ env?: NodeJS.ProcessEnv, spawn?: typeof import("./child-spawn.js").spawnRaw }} [via]
 * @returns {StopOutcome}
 */
function stopOn(seat, id, bin, { env = process.env, spawn } = {}) {
	const run = stopHeadless(id);
	if (run) return run;
	const r = runClaude(["stop", id], {
		env: buildSeatEnv(env, seat),
		timeout: STOP_TIMEOUT_MS,
		bin,
		spawn,
	});
	if (!r.failed) return { ok: true, said: r.stdout.trim() || "ok" };
	const said =
		r.stderr
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.pop()
			?.slice(0, 120) ?? null;
	const errCode = caught(r.error).code;
	const code = errCode || `exit ${r.status ?? "on a signal"}`;
	return {
		ok: false,
		why: said ? `${code}: ${said}` : code,
		said,
		timedOut: errCode === "ETIMEDOUT",
		noJob: NO_JOB_ANSWER.test(said ?? ""),
	};
}

/**
 * @param {string} id
 * @returns {StopOutcome|null}
 */
function stopHeadless(id) {
	let outcome;
	try {
		outcome = headless.stop(id);
	} catch (e) {
		const why = `headless run ${id}: ${caught(e).message}`;
		return { ok: false, why, said: null, timedOut: false, noJob: false };
	}
	if (outcome === "unknown") return null;
	if (outcome === "not running")
		return {
			ok: false,
			why: `headless run ${id} is not running`,
			said: null,
			timedOut: false,
			noJob: true,
		};
	return { ok: true, said: `headless run ${id} ${outcome}` };
}

module.exports = {
	NO_JOB_ANSWER,
	readOwnJob,
	stopOn,
	stopSession,
};
