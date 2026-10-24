/*
 * Which test modules the suite has started and not finished, on disk, so a
 * wrapper OUTSIDE the vitest process can name the file a stalled run is parked
 * in (mantahostels#1910's follow-on).
 *
 * WHY THIS CANNOT LIVE INSIDE VITEST. `testTimeout` is enforced on the event
 * loop, so it can only fire on a test that yields. A SYNCHRONOUS call that never
 * returns never yields, so no timeout inside the worker is ever reached, the
 * worker parks forever, and the parent waits on it with no output at all. Only a
 * watcher in a different process can see that, and once it kills the run the
 * in-process reporter is gone with it.
 *
 * STAGE, NOT JUST NAME. A module parked at import never reaches collection, one
 * parked in a test does — so `stage` turns "somewhere in this file" into "while
 * loading it" or "while running its tests".
 *
 * THE FILE'S MTIME IS ALSO A HEARTBEAT (workflow-core#1149). A long test file prints nothing
 * until it ends, so output alone cannot tell a slow file from a parked one;
 * `beat` touches the file on every test and hook event, and the watchdog reads
 * a fresh mtime as a sign of life. Per-test events reach the vitest parent while
 * another worker is parked in a synchronous call — scripts/vitest-inflight-reporter.test.ts
 * proves it against a real run.
 *
 * NEVER THROWS, on any path. This is instrumentation attached to every suite
 * run; a store it cannot write must cost the diagnosis, never the run.
 */

const fs = require("node:fs");
const { markersDir } = require("./marker-root.js");
const path = require("node:path");

const INFLIGHT_FILE = ".test-inflight.json";
const INFLIGHT_ENV = "WFC_INFLIGHT_FILE";

/**
 * Where this run's record lives.
 *
 * THE WRAPPER NAMES A PER-RUN FILE THROUGH THE ENVIRONMENT, because 2-3
 * concurrent suites are sanctioned on this machine and one fixed name means a
 * neighbour's `onTestRunEnd` deletes the parked run's rows — leaving the
 * watchdog with nothing to name in exactly the contended case it is for. The
 * repo-root default is what a bare `vitest run` outside the wrapper gets, where
 * nothing reads the file anyway.
 * @param {string} root
 */
const inflightPath = (root) =>
	process.env[INFLIGHT_ENV] || path.join(markersDir(root), INFLIGHT_FILE);

/**
 * The set this process has entered and not left, held in memory and mirrored to
 * disk on every change.
 *
 * IN MEMORY AS WELL AS ON DISK because the writer is one process — the vitest
 * main process, where every reporter hook runs — so re-reading the file to
 * mutate it would buy nothing and could lose an entry to a half-written read.
 * @type {Map<string, string>}
 */
const open = new Map();

/** The modules that finished, in order, for a stall kill's record (workflow-core#1149).
 * @type {string[]} */
const finished = [];

/** @param {string} root */
function flush(root) {
	try {
		const rows = [...open].map(([module, stage]) => ({ module, stage }));
		fs.writeFileSync(
			inflightPath(root),
			`${JSON.stringify({ open: rows, finished })}\n`,
		);
	} catch {
		/* Swallowed rather than reported: this runs on every module transition of
		 * every suite, so a store it cannot write would otherwise emit hundreds of
		 * identical lines into the run's own output. The silence is legible at the
		 * only place that reads the record — run-vitest.js says so when a stall
		 * finds no rows. */
	}
}

/**
 * Starts a run with an empty record, so a reader never meets the previous run's
 * leftovers and mistakes them for this one's.
 * @param {string} root
 */
function begin(root) {
	open.clear();
	finished.length = 0;
	flush(root);
}

/**
 * @param {string} root
 * @param {string|undefined} moduleId
 * @param {string} stage
 */
function enter(root, moduleId, stage) {
	if (!moduleId) return;
	open.set(moduleId, stage);
	flush(root);
}

/**
 * @param {string} root
 * @param {string|undefined} moduleId
 */
function leave(root, moduleId) {
	if (!moduleId) return;
	open.delete(moduleId);
	finished.push(moduleId);
	flush(root);
}

/**
 * A sign of life between module transitions: the file's mtime moves, its
 * content does not.
 * @param {string} root
 */
function beat(root) {
	try {
		const now = new Date();
		fs.utimesSync(inflightPath(root), now, now);
	} catch {
		/* a lost beat can cost a false stall kill, never the run's own result */
	}
}

/**
 * When the record at `file` last moved, in epoch ms; 0 where it cannot be read.
 * @param {string} file
 */
function lastBeat(file) {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * What is in flight under `root`'s record.
 * @param {string} root
 * @returns {{ module: string, stage: string }[]}
 */
function read(root) {
	return readRecord(inflightPath(root)).open;
}

/**
 * What the wrapper reads after it kills a stalled run, by explicit path, since
 * it names the per-run file itself and has no root to derive it from.
 *
 * AN UNREADABLE OR CORRUPT FILE READS AS NO RECORD, never as a throw.
 * @param {string} file
 * @returns {{ open: { module: string, stage: string }[], finished: string[] }}
 */
function readRecord(file) {
	try {
		const record = JSON.parse(fs.readFileSync(file, "utf8"));
		const recordOpen = record?.open;
		const recordFinished = record?.finished;
		return {
			open: Array.isArray(recordOpen)
				? recordOpen.filter((r) => r?.module)
				: [],
			finished: Array.isArray(recordFinished)
				? recordFinished.filter((f) => typeof f === "string")
				: [],
		};
	} catch {
		return { open: [], finished: [] };
	}
}

/** @param {string} root */
function clear(root) {
	open.clear();
	finished.length = 0;
	clearFile(inflightPath(root));
}

/**
 * The same delete, by explicit path — run-vitest.js's tidy-up of the per-run
 * file it named.
 * @param {string} file
 */
function clearFile(file) {
	try {
		fs.rmSync(file, { force: true });
	} catch {
		/* A record that outlives its run is read by nobody: the wrapper names a
		 * fresh path per run, and `begin` empties whatever it finds. */
	}
}

module.exports = {
	INFLIGHT_ENV,
	beat,
	begin,
	clear,
	clearFile,
	enter,
	lastBeat,
	leave,
	read,
	readRecord,
};
