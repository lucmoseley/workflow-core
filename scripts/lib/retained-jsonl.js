/*
 * retained-jsonl.js — append one JSON line to a log that keeps its own
 * history by age: lines whose `at` is older than the caller's retention go.
 *
 * NO APPEND IS LOST TO A PRUNE (#4819). Every append, prune and removal of a
 * log runs under a lock directory beside it (lib/dir-lock.js), so no writer
 * appends between a prune's read and its rewrite. A writer that cannot get
 * the lock still appends, which is safe on its own, and prunes nothing. The
 * rewrite is an atomic rename, so a reader never sees a log cut short.
 *
 * NEVER THROWS: an unwritable log costs the line, never the caller's run.
 * Synchronous throughout, because the queue's signal handler calls it on its
 * way to exit.
 */

const fs = require("node:fs");
const { readJsonl } = require("./jsonl.js");
const { withDirLock } = require("./dir-lock.js");
const { writeFileAtomic } = require("./atomic-write.js");

const DAY_MS = 24 * 60 * 60 * 1000;

/** @param {string} file */
const lockOf = (file) => `${file}.lock`;

/**
 * @param {string|null} file
 * @param {Record<string, unknown> & { at: string }} entry
 * @param {number} retainMs
 * @param {{dropOnBadLine?: boolean, now?: () => number}} [options]
 *   `dropOnBadLine` empties a log holding a line that will not parse before
 *   appending, for a reader to whom a lost line may be a newer verdict
 * @returns {boolean} whether the line landed
 */
function appendRetained(
	file,
	entry,
	retainMs,
	{ dropOnBadLine = false, now = Date.now } = {},
) {
	if (!file) return false;
	try {
		return withDirLock(
			lockOf(file),
			(held) => {
				if (held && dropOnBadLine) dropIfBad(file);
				try {
					fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
				} catch {
					return false;
				}
				if (held) prune(file, retainMs, now());
				return true;
			},
			now,
		);
	} catch {
		return false;
	}
}

/** @param {string} file */
function dropIfBad(file) {
	try {
		const read = readJsonl(file);
		if (read && read.bad.length > 0) fs.rmSync(file, { force: true });
	} catch {
		/* an unreadable log fails the append that follows */
	}
}

/**
 * Rewrite `file` without its lines past `retainMs`, once its oldest is a day
 * past it, so a log is rewritten about once a day rather than on every append.
 * @param {string} file
 * @param {number} retainMs
 * @param {number} now
 */
function prune(file, retainMs, now) {
	try {
		const read = readJsonl(file);
		if (!read) return;
		const ageOf = (/** @type {Record<string, unknown>} */ row) =>
			now - Date.parse(String(row.at));
		const [oldest] = read.rows;
		if (oldest === undefined || !(ageOf(oldest) > retainMs + DAY_MS)) return;
		writeFileAtomic(
			file,
			read.rows
				.filter((row) => ageOf(row) <= retainMs)
				.map((row) => `${JSON.stringify(row)}\n`)
				.join(""),
		);
	} catch {
		/* the line is written; a failed prune costs disk, not the record */
	}
}

/**
 * Delete `file` where it was last written before `beforeMs`, under its lock,
 * so an append landing as it goes is never deleted with it. Throws where the
 * removal does; a lock not got removes nothing.
 * @param {string} file
 * @param {number} beforeMs
 * @param {() => number} [now]
 */
function removeUntouched(file, beforeMs, now = Date.now) {
	withDirLock(
		lockOf(file),
		(held) => {
			const stat = fs.statSync(file, { throwIfNoEntry: false });
			if (held && stat && stat.mtimeMs < beforeMs)
				fs.rmSync(file, { force: true });
		},
		now,
	);
}

module.exports = { DAY_MS, appendRetained, removeUntouched };
