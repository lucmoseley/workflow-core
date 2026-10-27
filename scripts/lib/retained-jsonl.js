/*
 * retained-jsonl.js — append one JSON line to a log that keeps its own
 * history by age: lines whose `at` is older than the caller's retention go.
 *
 * THE PRUNE RACES AN APPEND: a writer appending between its read and rewrite
 * loses its line. It rewrites only once the oldest line is a day past
 * retention, so that window opens about once a day rather than on every
 * append.
 *
 * NEVER THROWS: an unwritable log costs the line, never the caller's run.
 * Synchronous throughout, because the queue's signal handler calls it on its
 * way to exit.
 */

const fs = require("node:fs");

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {string|null} file
 * @param {Record<string, unknown> & { at: string }} entry
 * @param {number} retainMs
 * @returns {boolean} whether the line landed
 */
function appendRetained(file, entry, retainMs) {
	if (!file) return false;
	try {
		fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
	} catch {
		return false;
	}
	try {
		const now = Date.now();
		const lines = String(fs.readFileSync(file, "utf8"))
			.split("\n")
			.filter(Boolean);
		const ageOf = (/** @type {string} */ line) => {
			try {
				return now - Date.parse(JSON.parse(line).at);
			} catch {
				return Number.POSITIVE_INFINITY;
			}
		};
		const isFresh = (/** @type {string} */ line) => ageOf(line) <= retainMs;
		const [oldest] = lines;
		if (oldest !== undefined && ageOf(oldest) > retainMs + DAY_MS)
			fs.writeFileSync(file, `${lines.filter(isFresh).join("\n")}\n`);
	} catch {
		/* the line is written; a failed prune costs disk, not the record */
	}
	return true;
}

module.exports = { DAY_MS, appendRetained };
