/*
 * latest-timings.js — the per-file timings file a local reader uses: the
 * lander's sharded runs pack by it and the run-cost report judges growth
 * against it (workflow-core#4579). It is the newest green suite run's, as CI's shards read
 * theirs at run time (workflow-core#4574), kept in a cache every checkout of the repository
 * shares through the git common dir.
 *
 * ONE FILE PER SOURCE RUN, NEVER REWRITTEN: `<run>.csv`. A caller that hands
 * one path to several runs, as the lander does its shards minutes apart, so
 * gives them one dataset though another checkout refreshes the cache between
 * them. The newest KEPT stay.
 *
 * CHECKED AT MOST ONCE PER CHECK_MS, by the first reader after it; a failed
 * or abandoned check is retried RETRY_MS later. The attempt is stamped
 * before the check, so readers at once do not all fetch. A check lists the
 * runs and downloads only a run not yet held: about 10 s for one.
 *
 * NO FILE ONCE THE LAST PASSED CHECK IS STALE_MS OLD: workflow-core#4579's bound of a day
 * behind the newest green run. The lander then splits by file count and the
 * run-cost report reads no record.
 *
 * WFC_SHARD_TIMINGS, WHERE SET, IS THE FILE: a CI shard's own (workflow-core#4574), or a
 * test's. Under `CI` without it nothing is fetched: only a shard reads
 * timings there.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { gitCommonDir } = require("./git.js");
const { readNewestRun, readSuiteRepo, toCsv } = require("./suite-timings.js");

const HOUR_MS = 60 * 60 * 1000;
/* A guess inside STALE_MS: four checks a day, each a listing and at most one
 * download. */
const CHECK_MS = 6 * HOUR_MS;
/* A guess: GitHub's outages mostly clear within the hour. */
const RETRY_MS = HOUR_MS / 2;
const STALE_MS = 24 * HOUR_MS;
/* Untraced: more than the refreshes one lander batch can straddle. */
const KEPT = 5;
/* The last check begun, and the last that passed, by their mtimes. */
const ATTEMPTED = "attempted";
const PASSED = "passed";
const HELD = /^(\d+)\.csv$/;

/**
 * @typedef {{ file: string|null, failed: string|null }} Timings
 *   `file` the newest held timings, null where none is; `failed` why this
 *   read's check failed, null where it passed or none was due
 * @typedef {(root: string, now: number, held: (run: number) => boolean) =>
 *   ReturnType<typeof readNewestRun>} Fetch
 */

/** @type {Fetch} */
const fetchNewest = (root, now, held) =>
	readNewestRun(readSuiteRepo(root), now, root, held);

/**
 * The run ids `dir` holds, newest first.
 * @param {string} dir
 * @returns {number[]}
 */
function readHeldRuns(dir) {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.map((n) => HELD.exec(n)?.[1])
		.filter((n) => n !== undefined)
		.map(Number)
		.sort((a, b) => b - a);
}

/**
 * When `name`'s stamp in `dir` was last set, or null where it never was.
 * @param {string} dir
 * @param {string} name
 * @returns {number|null}
 */
function readStamp(dir, name) {
	try {
		return fs.statSync(path.join(dir, name)).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * Sets `name`'s stamp in `dir` to `now`.
 * @param {string} dir
 * @param {string} name
 * @param {number} now
 */
function writeStamp(dir, name, now) {
	const stamp = path.join(dir, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(stamp, "");
	const at = new Date(now);
	fs.utimesSync(stamp, at, at);
}

/**
 * Whether a check is due — the last pass CHECK_MS old, and the last attempt
 * RETRY_MS — stamping the attempt where it is.
 * @param {string} dir
 * @param {number} now
 */
function claimDueCheck(dir, now) {
	const passed = readStamp(dir, PASSED);
	const attempted = readStamp(dir, ATTEMPTED);
	if (passed !== null && now - passed < CHECK_MS) return false;
	if (attempted !== null && now - attempted < RETRY_MS) return false;
	writeStamp(dir, ATTEMPTED, now);
	return true;
}

/**
 * The newest run's file written into `dir` where not yet held, and all but
 * the newest KEPT dropped, and the pass stamped.
 * @param {string} dir
 * @param {string} root
 * @param {number} now
 * @param {Fetch} fetch
 */
function refresh(dir, root, now, fetch) {
	const found = fetch(root, now, (run) =>
		fs.existsSync(path.join(dir, `${run}.csv`)),
	);
	if (found === null) throw new Error("no green suite run holds reports");
	if (found.rows !== null) {
		const tmp = path.join(dir, `.${found.run}.${process.pid}.tmp`);
		fs.writeFileSync(
			tmp,
			toCsv(found.rows, { run: found.run, sha: found.sha }),
		);
		fs.renameSync(tmp, path.join(dir, `${found.run}.csv`));
	}
	for (const run of readHeldRuns(dir).slice(KEPT))
		fs.rmSync(path.join(dir, `${run}.csv`), { force: true });
	writeStamp(dir, PASSED, now);
}

/**
 * The timings file a local reader in `root` uses. Never throws.
 * @param {string} root
 * @param {{ now?: number, fetch?: Fetch }} [seams] a test's clock and GitHub
 * @returns {Timings}
 */
function latestTimings(root, { now = Date.now(), fetch = fetchNewest } = {}) {
	const named = process.env.WFC_SHARD_TIMINGS;
	if (named) return { file: fs.existsSync(named) ? named : null, failed: null };
	if (process.env.CI) return { file: null, failed: null };
	const common = gitCommonDir(root);
	if (common === null)
		return { file: null, failed: `git names no common dir at ${root}` };
	const dir = path.join(common, "workflow-core", "suite-timings");
	let failed = null;
	try {
		if (claimDueCheck(dir, now)) refresh(dir, root, now, fetch);
	} catch (error) {
		failed = caught(error).message.trim();
	}
	const passed = readStamp(dir, PASSED);
	if (passed === null || now - passed >= STALE_MS)
		return {
			file: null,
			failed: failed ?? "the last passed check is a day old",
		};
	const [newest] = readHeldRuns(dir);
	return {
		file: newest === undefined ? null : path.join(dir, `${newest}.csv`),
		failed,
	};
}

module.exports = { latestTimings };
