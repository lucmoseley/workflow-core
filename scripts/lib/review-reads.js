/*
 * review-reads.js — the morning review's slow reads kept for the day it files
 * (workflow-core#3765): each repo's check-primitives.js count line and each label age read
 * off a timeline. A filing killed part way, by the refill loop's runner bound
 * or by hand, resumes from them on its retry instead of starting again.
 *
 * Kept per machine-local date in lib/refill-dir.js's directory, beside the
 * loop's own files, and written after each read. A file from another day is
 * read as empty. Only a read that succeeded is kept: a failed one is retried.
 *
 * A dry run takes freshReads instead (workflow-core#3813): it writes nothing a later filing would
 * take for its own, and shows what is true now.
 */

const { writeFileAtomic } = require("./atomic-write.js");
const { refillPath } = require("./refill-dir.js");
const { readJson } = require("./refill-files.js");
const { writeFd } = require("./write-fd.js");

const READS_FILE = ".morning-review-reads.json";

/**
 * @param {string} file
 * @param {string} day
 * @returns {Record<string, unknown>}
 */
function load(file, day) {
	/* Fail open (workflow-core#3765): a damaged file costs only the day's kept reads, and
	 * writes here are atomic, so it is a fault to print (workflow-core#3814). */
	/** @param {string} line */
	const print = (line) => writeFd(2, `${line}\n`);
	const kept =
		/** @type {{day?: string, reads?: Record<string, unknown>}|null} */ (
			readJson(file, print)
		);
	return kept?.day === day && kept.reads && typeof kept.reads === "object"
		? kept.reads
		: {};
}

/**
 * The day's kept reads: `read(key, fresh, keep)` answers the kept value under
 * `key`, else runs `fresh` and keeps its value where `keep` accepts it.
 * @param {string} day machine-local date (lib/morning-review.js's localDate)
 * @param {string} [file]
 */
function reviewReads(day, file = refillPath(READS_FILE)) {
	let reads = load(file, day);
	return {
		/**
		 * @template T
		 * @param {string} key
		 * @param {() => T} fresh
		 * @param {(value: T) => boolean} keep
		 * @returns {T}
		 */
		read(key, fresh, keep) {
			if (Object.hasOwn(reads, key)) return /** @type {T} */ (reads[key]);
			const value = fresh();
			if (keep(value)) {
				reads = { ...reads, [key]: value };
				writeFileAtomic(file, `${JSON.stringify({ day, reads })}\n`, {
					mkdir: true,
				});
			}
			return value;
		},
	};
}

/** reviewReads' shape over no file: every read runs, and nothing is kept. */
const freshReads = () => ({
	/**
	 * @template T
	 * @param {string} _key
	 * @param {() => T} fresh
	 * @returns {T}
	 */
	read: (_key, fresh) => fresh(),
});

module.exports = { freshReads, reviewReads };
