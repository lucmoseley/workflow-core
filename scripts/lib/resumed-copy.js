/*
 * resumed-copy.js — the job a `claude --bg --resume` started, found in a seat's
 * job store with nothing but the resume's target and time (#4157, #4180): the
 * stopped job woken in place, or a copy. A copy's job record names only its own
 * session, but its transcript carries its source's rows, uuids and all, so the
 * two open on the same user row.
 *
 * Residual: a copy of the session started by hand in the same cwd since the
 * resume opens on that row too, and is taken for the loop's; so is a wake by
 * hand, such as a `claude attach`, of the stopped job in place.
 */

const fs = require("node:fs");
const { jobStorePath, readJobRecord, shortJobId } = require("./job-paths.js");
const { parseJsonl } = require("./jsonl.js");
const { readWholeLines } = require("./session-transcript.js");
const { findTranscript } = require("./transcript.js");

const ENDED_STATES = new Set(["stopped", "failed", "done"]);

/**
 * The uuid of the first user row in transcript `file`, read as far as that row;
 * null where it has none.
 * @param {string} file
 * @throws where the file will not open or read
 */
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
 * The copy a `--bg --resume` of `target`'s session on `seat` started from `since`
 * on: a job created since, in the same cwd, not failed, under a session neither
 * the target's nor in `past`, whose transcript opens on the target's first user
 * row; the earliest such. Null where none is, or the seat has no job store;
 * `unread` where the store or the target's transcript will not read.
 * @param {string} seat
 * @param {{sessionId: string, cwd: string}} target
 * @param {number} since
 * @param {string[]} past  sessions the launch ran under before, whose copies
 *   are its earlier resumes, not this one
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
		/* A seat with no job store holds no copy. */
		if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT" && first)
			return null;
		return { unread: e instanceof Error ? e.message : String(e) };
	}
	if (!first) return null;
	const skipped = new Set([sessionId, ...past]);
	/** @type {{jobId: string, sessionId: string, createdAt: number}[]} */
	const copies = [];
	for (const jobId of dirs) {
		const rec = readJobRecord(seat, jobId);
		if (!isCandidate(rec, { skipped, cwd, since })) continue;
		const file = findTranscript(seat, rec.sessionId);
		if (file && readUuidOrNull(file) === first)
			copies.push({
				jobId,
				sessionId: rec.sessionId,
				createdAt: Date.parse(rec.createdAt),
			});
	}
	const [copy] = copies.sort((a, b) => a.createdAt - b.createdAt);
	return copy ? { jobId: copy.jobId, sessionId: copy.sessionId } : null;
}

/**
 * The job a `--bg --resume` of `target`'s session on `seat` started from `since`
 * on: its own job woken in place, else findResumedCopy's copy.
 * @param {string} seat
 * @param {{sessionId: string, cwd: string}} target
 * @param {number} since
 * @param {string[]} past  as findResumedCopy's
 * @returns {{jobId: string, sessionId: string, copy: boolean}|{unread: string}|null}
 */
function findResumed(seat, target, since, past) {
	const woken = findWokenInPlace(seat, target, since);
	if (woken) return { ...woken, copy: false };
	const copy = findResumedCopy(seat, target, since, past);
	return copy && !("unread" in copy) ? { ...copy, copy: true } : copy;
}

/**
 * `target`'s own job, woken in place on `seat` from `since` on: a stopped job's
 * resume keeps its job and session ids (lib/bg-resume.js), so its record, under
 * the session's short id, reads live again, not ENDED_STATES, and updated since.
 * @param {string} seat
 * @param {{sessionId: string, cwd: string}} target
 * @param {number} since
 * @returns {{jobId: string, sessionId: string}|null}
 */
function findWokenInPlace(seat, { sessionId, cwd }, since) {
	const jobId = shortJobId(sessionId);
	const rec = readJobRecord(seat, jobId);
	return rec?.sessionId === sessionId &&
		rec.cwd === cwd &&
		!ENDED_STATES.has(rec.state) &&
		Date.parse(rec.updatedAt) >= since
		? { jobId, sessionId }
		: null;
}

/**
 * Whether job record `rec` may be the copy: a session not in `skipped`, in
 * `cwd`, not failed, created from `since` on.
 * @param {any} rec  untyped: the harness owns its schema
 * @param {{skipped: Set<string>, cwd: string, since: number}} want
 */
const isCandidate = (rec, { skipped, cwd, since }) =>
	typeof rec?.sessionId === "string" &&
	!skipped.has(rec.sessionId) &&
	rec.cwd === cwd &&
	rec.state !== "failed" &&
	Date.parse(rec.createdAt) >= since;

/**
 * readFirstUserUuid's answer, null where `file` will not read: a candidate
 * whose transcript cannot be read cannot be shown to be the copy.
 * @param {string} file
 */
function readUuidOrNull(file) {
	try {
		return readFirstUserUuid(file);
	} catch {
		return null;
	}
}

module.exports = { findResumed };
