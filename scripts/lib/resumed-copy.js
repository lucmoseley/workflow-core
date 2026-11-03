/*
 * resumed-copy.js — the copy a `claude --bg --resume` started, found in a seat's
 * job store with nothing but the resume's target and time (#4157). A copy's job
 * record names only its own session, but its transcript carries its source's
 * rows, uuids and all, so the two open on the same user row.
 *
 * Residual: a copy of the session started by hand in the same cwd since the
 * resume opens on that row too, and is taken for the loop's.
 */

const fs = require("node:fs");
const { jobStorePath, readJobRecord } = require("./job-paths.js");
const { parseJsonl } = require("./jsonl.js");
const { readWholeLines } = require("./session-transcript.js");
const { findTranscript } = require("./transcript.js");

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

module.exports = { findResumedCopy };
