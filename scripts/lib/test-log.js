const fs = require("node:fs");
const { readJsonl } = require("./jsonl.js");
const { markersDir } = require("./marker-root.js");
const path = require("node:path");
const { ignoreFailure, orFallback } = require("./caught.js");

const DIR_NAME = ".test-logs";

// lucmoseley/mantahostels#1943 guess
const KEEP_RUNS = 30;

/** @param {string} root */
const dirPath = (root) => path.join(markersDir(root), DIR_NAME);

const RUNS_PREFIX = "runs-";
const RUNS_SUFFIX = ".jsonl";

/**
 * @param {string} root
 * @param {string} session
 */
const runsPath = (root, session) =>
	path.join(dirPath(root), `${RUNS_PREFIX}${session}${RUNS_SUFFIX}`);

/**
 * @typedef {{ log: string, pid: number, startedAt: string, endedAt: string }} RunRecord
 */

/**
 * @param {string} root
 * @param {string} session
 * @param {RunRecord} run
 * @returns {boolean}
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
 * @param {string} root
 * @param {string} session
 * @returns {RunRecord[]}
 */
function readRuns(root, session) {
	const read = orFallback(() => readJsonl(runsPath(root, session)), null);
	return /** @type {RunRecord[]} */ (
		(read?.rows ?? []).filter((run) => typeof run.log === "string")
	);
}

/**
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
 * @param {string} dir
 * @param {{ keep?: number, fs?: ReapFs }} [options]
 * @returns {string[]}
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
	/** @type {string[]} */
	const removed = [];
	for (const { path: p } of entries.slice(0, excess)) {
		ignoreFailure(() => {
			fsImpl.unlinkSync(p);
			removed.push(p);
		});
	}
	const oldestKept = entries[excess]?.mtime ?? Number.POSITIVE_INFINITY;
	for (const name of names) {
		if (!name.startsWith(RUNS_PREFIX) || !name.endsWith(RUNS_SUFFIX)) continue;
		const p = path.join(dir, name);
		ignoreFailure(() => {
			if (fsImpl.statSync(p).mtimeMs >= oldestKept) return;
			fsImpl.unlinkSync(p);
			removed.push(p);
		});
	}
	return removed;
}

module.exports = { dirPath, logPath, reap, runsPath, recordRun, readRuns };
