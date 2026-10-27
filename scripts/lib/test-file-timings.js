/*
 * test-file-timings.js — each test file's own wall time in a vitest run, from
 * the module being queued to its end, so scripts/run-vitest.js can print the
 * run-cost report after the suite's summary (#1883, under #1869's spec).
 *
 * QUEUED TO END, NEVER A SUM OF TEST DURATIONS, which hides import time and
 * `beforeAll` (#1150). Environment setup, collection and hooks all fall
 * inside the span.
 *
 * RECORDED BY THE IN-FLIGHT REPORTER, never the pass reporter, which must
 * never turn a green red; and the in-flight reporter is the one an adopter's
 * config already attaches (docs/agents/helper-surface.md), so the report
 * reaches it with no edit.
 *
 * THE CALLER PASSES THE CLOCK AND THE FILE: a test hands in numbers and a
 * path of its own, and never writes the live run's record through an
 * inherited environment (mantahostels#2790).
 *
 * NEVER THROWS (mantahostels#2255): a lost record costs the report, never the
 * run, and says so in one stderr line.
 */

const fs = require("node:fs");

/* The wrapper names a per-run file here, as it does the in-flight one. */
const TIMINGS_ENV = "WFC_RUN_TIMINGS_FILE";

/* How many of a run's slowest files its pass marker keeps, for
 * check-suite-margin.js to name (#2770). A guess, never measured: enough to
 * show where to cut, few enough to read in a status report. */
const SLOWEST_KEPT = 10;

/** @typedef {{ file: string, seconds: number }} SlowFile */

/**
 * One run's recorder.
 * @param {{ write: (s: string) => unknown }} [err]
 */
function createTimings(err = process.stderr) {
	/** Queued modules not yet ended, to the clock reading they were queued at.
	 * @type {Map<string, number>} */
	const queued = new Map();
	/** Ended modules to their seconds.
	 * @type {Map<string, number>} */
	const seconds = new Map();
	return {
		/**
		 * @param {string|undefined} moduleId
		 * @param {number} atMs a monotonic clock reading
		 */
		start(moduleId, atMs) {
			if (moduleId) queued.set(moduleId, atMs);
		},
		/**
		 * @param {string|undefined} moduleId
		 * @param {number} atMs the same clock as `start`'s
		 */
		end(moduleId, atMs) {
			const from = moduleId ? queued.get(moduleId) : undefined;
			if (!moduleId || from === undefined) return;
			queued.delete(moduleId);
			seconds.set(moduleId, (atMs - from) / 1000);
		},
		/**
		 * The `SLOWEST_KEPT` slowest ended modules, slowest first.
		 * @returns {SlowFile[]}
		 */
		slowest() {
			return [...seconds]
				.sort((a, b) => b[1] - a[1])
				.slice(0, SLOWEST_KEPT)
				.map(([file, s]) => ({ file, seconds: s }));
		},
		/**
		 * Writes every ended module's seconds to `file`, keyed by module id.
		 * @param {string|undefined} file
		 */
		save(file) {
			if (!file) return;
			try {
				fs.writeFileSync(
					file,
					`${JSON.stringify(Object.fromEntries(seconds))}\n`,
				);
			} catch (error) {
				/* Fails open (mantahostels#2255): the wrapper reads an absent
				 * record as a run that timed nothing, so the loss is named here. */
				err.write(
					`run-cost timings not written to ${file} (${String(error)}) — this run prints no run-cost report\n`,
				);
			}
		},
	};
}

/**
 * Removes the record at `file`, the wrapper's tidy-up once it has read it.
 * @param {string} file
 * @param {{ write: (s: string) => unknown }} [err]
 */
function clear(file, err = process.stderr) {
	try {
		fs.rmSync(file, { force: true });
	} catch (error) {
		/* Fails open (mantahostels#2255): a leftover can be read as a later
		 * run's figures in this process, so the loss is named. */
		err.write(
			`run-cost timings at ${file} not removed (${String(error)}) — a later run's report may read them\n`,
		);
	}
}

module.exports = { TIMINGS_ENV, clear, createTimings };
