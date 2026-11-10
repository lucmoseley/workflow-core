/*
 * retained-jsonl.js — append one JSON line to a log that keeps its own
 * history by age: lines whose `at` is older than the caller's retention go.
 *
 * NO APPEND IS LOST TO A PRUNE (#4819). Every append, prune and removal of a
 * log runs under a lock directory beside it (lib/dir-lock.js). A writer that waits the lock
 * out appends anyway and prunes nothing; a holder stalled past that wait, or
 * past the lock's stale takeover, carries over whatever such a writer
 * appended after its read (`replaceCarrying`). The rewrite is an atomic
 * rename, so a reader never sees a log cut short.
 *
 * NEVER THROWS: an unwritable log costs the line, never the caller's run.
 * Synchronous throughout, because the queue's signal handler calls it on its
 * way to exit.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { parseJsonl } = require("./jsonl.js");
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
	let landed = false;
	try {
		withDirLock(
			lockOf(file),
			(held) => {
				if (held && dropOnBadLine)
					replaceCarrying(file, (text) =>
						parseJsonl(text).bad.length > 0 ? null : undefined,
					);
				fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
				landed = true;
				if (held) prune(file, retainMs, now());
			},
			now,
		);
	} catch {
		/* a log that will not take the line costs the line */
	}
	return landed;
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
		replaceCarrying(file, (text) => {
			const { rows } = parseJsonl(text);
			const ageOf = (/** @type {Record<string, unknown>} */ row) =>
				now - Date.parse(String(row.at));
			const [oldest] = rows;
			if (oldest === undefined || !(ageOf(oldest) > retainMs + DAY_MS)) return;
			return rows
				.filter((row) => ageOf(row) <= retainMs)
				.map((row) => `${JSON.stringify(row)}\n`)
				.join("");
		});
	} catch {
		/* the line is written; a failed prune costs disk, not the record */
	}
}

/**
 * Replace `file` with what `next` makes of its text, deleting it on null and
 * leaving it on undefined, then append to the new file any bytes written to
 * the old one after it was read. Leaves a file another holder has already
 * replaced. Throws where a step does.
 * @param {string} file
 * @param {(text: string) => string | null | undefined} next
 */
function replaceCarrying(file, next) {
	let fd;
	try {
		fd = fs.openSync(file, "r");
	} catch (e) {
		if (caught(e).code === "ENOENT") return;
		throw e;
	}
	try {
		const { ino } = fs.fstatSync(fd);
		const text = fs.readFileSync(fd);
		const out = next(text.toString("utf8"));
		if (out === undefined) return;
		if (fs.statSync(file, { throwIfNoEntry: false })?.ino !== ino) return;
		if (out === null) fs.rmSync(file, { force: true });
		else writeFileAtomic(file, out);
		for (let read = text.length; ; ) {
			const { size } = fs.fstatSync(fd);
			if (size <= read) break;
			const tail = Buffer.alloc(size - read);
			fs.readSync(fd, tail, 0, tail.length, read);
			fs.appendFileSync(file, tail);
			read = size;
		}
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Delete every log in `dir` last written before `beforeMs`, under its lock,
 * and any lock or rewrite aside a crashed writer left beside one. Throws
 * where a removal does.
 * @param {string} dir
 * @param {number} beforeMs
 * @param {() => number} [now]
 */
function sweepRetained(dir, beforeMs, now = Date.now) {
	for (const name of fs.readdirSync(dir)) {
		const entry = path.join(dir, name);
		if (name.endsWith(".jsonl")) removeUntouched(entry, beforeMs, now);
		else if (name.includes(".jsonl.") && writtenBefore(entry, beforeMs))
			fs.rmSync(entry, { recursive: true, force: true });
	}
}

/**
 * @param {string} file
 * @param {number} beforeMs
 */
const writtenBefore = (file, beforeMs) => {
	const stat = fs.statSync(file, { throwIfNoEntry: false });
	return stat !== undefined && stat.mtimeMs < beforeMs;
};

/**
 * Delete `file` where it was last written before `beforeMs`, under its lock.
 * @param {string} file
 * @param {number} beforeMs
 * @param {() => number} now
 */
function removeUntouched(file, beforeMs, now) {
	withDirLock(
		lockOf(file),
		(held) => {
			if (held && writtenBefore(file, beforeMs))
				replaceCarrying(file, () => null);
		},
		now,
	);
}

module.exports = { DAY_MS, appendRetained, sweepRetained };
