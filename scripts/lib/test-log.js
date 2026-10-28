/*
 * test-log.js — the reap policy and path shape for the tee'd suite log
 * (mantahostels#1943).
 *
 * COUNT, NOT SIZE. log-rotate.js's size trigger fits one shared, ever-growing
 * file; this store is the opposite shape — one whole file per run — so the
 * bound that matters is how many runs are kept, not how big any one gets.
 */

const fs = require("node:fs");
const { readJsonl } = require("./jsonl.js");
const { markersDir } = require("./marker-root.js");
const path = require("node:path");

const DIR_NAME = ".test-logs";

/* An unmeasured first guess: enough runs to cover a working session's worth
 * of re-runs without growing without bound. Raise it once a session has
 * actually wanted a log this policy already reaped. */
const KEEP_RUNS = 30;

/** @param {string} root */
const dirPath = (root) => path.join(markersDir(root), DIR_NAME);

/* Beside the logs, so the reap below bounds the records with them. */
const RUNS_PREFIX = "runs-";
const RUNS_SUFFIX = ".jsonl";

/**
 * The record of a session's finished runs, one JSON line each (#1575). It is
 * how a reader finds THIS session's log once the run's own `TEST LOG:` line
 * was cut from its output: the newest log in the directory may be a
 * neighbour's.
 *
 * @param {string} root
 * @param {string} session
 */
const runsPath = (root, session) =>
	path.join(dirPath(root), `${RUNS_PREFIX}${session}${RUNS_SUFFIX}`);

/**
 * @typedef {{ log: string, pid: number, startedAt: string, endedAt: string }} RunRecord
 */

/**
 * Append one finished run. One append per line, never a rewrite, so two runs
 * of one session finishing together cannot drop each other's line. Never
 * throws: a record that cannot be written costs the lost-verdict hook its
 * answer, not the suite.
 *
 * @param {string} root
 * @param {string} session
 * @param {RunRecord} run
 * @returns {boolean} whether the line landed
 */
function recordRun(root, session, run) {
	const file = runsPath(root, session);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify(run)}\n`);
		return true;
	} catch {
		return false;
	}
}

/**
 * A session's finished runs, oldest first; a malformed line is skipped, and
 * an unreadable record reads as none.
 *
 * @param {string} root
 * @param {string} session
 * @returns {RunRecord[]}
 */
function readRuns(root, session) {
	let read = null;
	try {
		read = readJsonl(runsPath(root, session));
	} catch {
		/* An unreadable run log is no runs, as a missing one is: its readers
		 * report what they find and never fail on it. */
	}
	return /** @type {RunRecord[]} */ (
		(read?.rows ?? []).filter((run) => typeof run.log === "string")
	);
}

/**
 * The per-run log's path. Carries the pid because concurrent suites are
 * normal on this machine (mantahostels#1943), so two runs on the same sha in
 * the same second must not collide.
 *
 * @param {string} root
 * @param {string} sha
 * @param {Date} startedAt
 * @param {number} pid
 */
function logPath(root, sha, startedAt, pid) {
	const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
	return path.join(dirPath(root), `${sha}-${stamp}-${pid}.log`);
}

/**
 * @typedef {{ readdirSync: typeof import("node:fs").readdirSync,
 *   statSync: typeof import("node:fs").statSync,
 *   unlinkSync: typeof import("node:fs").unlinkSync }} ReapFs
 */

/**
 * Keep only the newest `keep` logs in `dir`, oldest evicted first, and drop
 * each session run record that now names only evicted logs. Never throws: a reap that cannot read or delete costs disk, not the suite it ran
 * for.
 *
 * @param {string} dir
 * @param {{ keep?: number, fs?: ReapFs }} [options]
 * @returns {string[]} the paths removed
 */
function reap(dir, { keep = KEEP_RUNS, fs: fsImpl = fs } = {}) {
	let entries;
	/** @type {string[]} */
	let names;
	try {
		names = fsImpl.readdirSync(dir);
		entries = names
			.filter((name) => name.endsWith(".log"))
			.map((name) => {
				const p = path.join(dir, name);
				return { path: p, mtime: fsImpl.statSync(p).mtimeMs };
			});
	} catch {
		return [];
	}
	entries.sort((a, b) => a.mtime - b.mtime);
	const excess = entries.length - keep;
	if (excess <= 0) return [];
	const removed = [];
	for (const { path: p } of entries.slice(0, excess)) {
		try {
			fsImpl.unlinkSync(p);
			removed.push(p);
		} catch {
			/* another concurrent suite may have reaped or replaced it first */
		}
	}
	/* A session's run record last written before the oldest kept log names
	 * only reaped logs. */
	const oldestKept = entries[excess]?.mtime ?? Number.POSITIVE_INFINITY;
	for (const name of names) {
		if (!name.startsWith(RUNS_PREFIX) || !name.endsWith(RUNS_SUFFIX)) continue;
		const p = path.join(dir, name);
		try {
			if (fsImpl.statSync(p).mtimeMs >= oldestKept) continue;
			fsImpl.unlinkSync(p);
			removed.push(p);
		} catch {
			/* written or reaped by a concurrent suite meanwhile */
		}
	}
	return removed;
}

module.exports = { dirPath, logPath, reap, runsPath, recordRun, readRuns };
