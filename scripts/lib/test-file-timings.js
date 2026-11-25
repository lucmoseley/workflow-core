const fs = require("node:fs");

const TIMINGS_ENV = "WFC_RUN_TIMINGS_FILE";

// workflow-core#2770 guess
const SLOWEST_KEPT = 10;

/** @typedef {{ file: string, seconds: number }} SlowFile */

function createTimings(err = process.stderr) {
	/** @type {Map<string, number>} */
	const queued = new Map();
	/** @type {Map<string, number>} */
	const seconds = new Map();
	return {
		/**
		 * @param {string|undefined} moduleId
		 * @param {number} atMs
		 */
		start(moduleId, atMs) {
			if (moduleId) queued.set(moduleId, atMs);
		},
		/**
		 * @param {string|undefined} moduleId
		 * @param {number} atMs
		 */
		end(moduleId, atMs) {
			const from = moduleId ? queued.get(moduleId) : undefined;
			if (!moduleId || from === undefined) return;
			queued.delete(moduleId);
			seconds.set(moduleId, (atMs - from) / 1000);
		},
		/** @returns {SlowFile[]} */
		slowest() {
			return [...seconds]
				.sort((a, b) => b[1] - a[1])
				.slice(0, SLOWEST_KEPT)
				.map(([file, s]) => ({ file, seconds: s }));
		},
		/** @param {string|undefined} file */
		save(file) {
			if (!file) return;
			try {
				fs.writeFileSync(
					file,
					`${JSON.stringify(Object.fromEntries(seconds))}\n`,
				);
			} catch (error) {
				err.write(
					`run-cost timings not written to ${file} (${String(error)}) — this run prints no run-cost report\n`,
				);
			}
		},
	};
}

/**
 * @param {string} file
 * @param {{ write: (s: string) => unknown }} [err]
 */
function clear(file, err = process.stderr) {
	try {
		fs.rmSync(file, { force: true });
	} catch (error) {
		err.write(
			`run-cost timings at ${file} not removed (${String(error)}) — a later run's report may read them\n`,
		);
	}
}

module.exports = { TIMINGS_ENV, clear, createTimings };
