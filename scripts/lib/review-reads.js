const { writeFileAtomic } = require("./atomic-write.js");
const { refillPath } = require("./refill-dir.js");
const { readJson } = require("./refill-json.js");
const { writeFd } = require("./write-fd.js");

const READS_FILE = ".morning-review-reads.json";

/**
 * @param {string} file
 * @param {string} day
 * @returns {Record<string, unknown>}
 */
function load(file, day) {
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
 * @param {string} day
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
