const fs = require("node:fs");
const {
	jobDirPath,
	jobStorePath,
	readJobRecordAt,
	shortJobId,
} = require("./job-paths.js");
const { parseJsonl } = require("./jsonl.js");
const { readWholeLines } = require("./session-transcript.js");
const { findTranscript } = require("./transcript.js");

const ENDED_STATES = new Set(["stopped", "failed", "done"]);

/** @param {string} file */
function readFirstUserUuid(file) {
	const fd = fs.openSync(file, "r");
	try {
		for (const chunk of readWholeLines(fd))
			for (const row of parseJsonl(chunk.toString("utf8")).rows) {
				const r = /** @type {{type?: unknown, uuid?: unknown}} */ (row);
				if (r.type === "user" && typeof r.uuid === "string") return r.uuid;
			}
		return null;
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * @param {string} seat
 * @param {{sessionId: string, cwd: string}} target
 * @param {number} since
 * @param {string[]} past
 * @returns {{jobId: string, sessionId: string}|{unread: string}|null}
 */
function findResumedCopy(seat, { sessionId, cwd }, since, past) {
	const source = findTranscript(seat, sessionId);
	if (!source) return { unread: `no transcript found for ${sessionId}` };
	let first;
	let dirs;
	try {
		first = readFirstUserUuid(source);
		dirs = fs.readdirSync(jobStorePath(seat));
	} catch (e) {
		if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT" && first)
			return null;
		return { unread: e instanceof Error ? e.message : String(e) };
	}
	if (!first) return null;
	const copies = readCopies(seat, dirs, {
		skipped: new Set([sessionId, ...past]),
		cwd,
		since,
		first,
	});
	if (!Array.isArray(copies)) return copies;
	const [copy] = copies.sort((a, b) => a.createdAt - b.createdAt);
	return copy ? { jobId: copy.jobId, sessionId: copy.sessionId } : null;
}

/**
 * @param {string} seat
 * @param {string[]} dirs
 * @param {{skipped: Set<string>, cwd: string, since: number, first: string}} want
 * @returns {{jobId: string, sessionId: string, createdAt: number}[]|{unread: string}}
 */
function readCopies(seat, dirs, { skipped, cwd, since, first }) {
	/** @type {{jobId: string, sessionId: string, createdAt: number}[]} */
	const copies = [];
	for (const jobId of dirs) {
		const r = readJobRecordAt(jobDirPath(seat, jobId));
		if (r.state === "unreadable") return { unread: r.message };
		const rec = r.state === "read" ? r.data : null;
		if (!isCandidate(rec, { skipped, cwd, since })) continue;
		const file = findTranscript(seat, rec.sessionId);
		if (file && readUuidOrNull(file) === first)
			copies.push({
				jobId,
				sessionId: rec.sessionId,
				createdAt: Date.parse(rec.createdAt),
			});
	}
	return copies;
}

/**
 * @param {string} seat
 * @param {{sessionId: string, cwd: string}} target
 * @param {number} since
 * @param {string[]} past
 * @returns {{jobId: string, sessionId: string, copy: boolean}|{unread: string}|null}
 */
function findResumed(seat, target, since, past) {
	const woken = findWokenInPlace(seat, target, since);
	if (woken) return "unread" in woken ? woken : { ...woken, copy: false };
	const copy = findResumedCopy(seat, target, since, past);
	return copy && !("unread" in copy) ? { ...copy, copy: true } : copy;
}

/**
 * @param {string} seat
 * @param {{sessionId: string, cwd: string}} target
 * @param {number} since
 * @returns {{jobId: string, sessionId: string}|{unread: string}|null}
 */
function findWokenInPlace(seat, { sessionId, cwd }, since) {
	const jobId = shortJobId(sessionId);
	const r = readJobRecordAt(jobDirPath(seat, jobId));
	if (r.state === "unreadable") return { unread: r.message };
	const rec = r.state === "read" ? r.data : null;
	return rec?.sessionId === sessionId &&
		rec.cwd === cwd &&
		!ENDED_STATES.has(rec.state) &&
		Date.parse(rec.updatedAt) >= since
		? { jobId, sessionId }
		: null;
}

/**
 * @param {any} rec
 * @param {{skipped: Set<string>, cwd: string, since: number}} want
 */
const isCandidate = (rec, { skipped, cwd, since }) =>
	typeof rec?.sessionId === "string" &&
	!skipped.has(rec.sessionId) &&
	rec.cwd === cwd &&
	rec.state !== "failed" &&
	Date.parse(rec.createdAt) >= since;

/** @param {string} file */
function readUuidOrNull(file) {
	try {
		return readFirstUserUuid(file);
	} catch {
		return null;
	}
}

module.exports = { findResumed };
