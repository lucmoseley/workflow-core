/*
 * latest-timings.js — the per-file timings file a local reader uses: the
 * lander's sharded runs pack by it and the run-cost report judges growth
 * against it (#4579). It is the newest green suite run's, as CI's shards read
 * theirs at run time (#4574), kept in a cache every checkout of the repository
 * shares through the git common dir.
 *
 * ONE FILE PER SOURCE RUN, NEVER REWRITTEN: `<run>.csv`. A caller that hands
 * one path to several runs, as the lander does its shards minutes apart, so
 * gives them one dataset though another checkout refreshes the cache between
 * them. The newest KEPT stay.
 *
 * CHECKED AT MOST ONCE PER CHECK_MS, by the first reader after it. The stamp
 * is set before the check, so readers at once do not all fetch, and a failed
 * check is retried a window later. A check lists the runs and downloads only
 * a run not yet held: about 10 s for one, measured 9 Nov 2026.
 *
 * WFC_SHARD_TIMINGS, WHERE SET, IS THE FILE: a CI shard's own (#4574), or a
 * test's. Under `CI` without it nothing is fetched: only a shard reads
 * timings there.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { gitCommonDir } = require("./git.js");
const { newestRun, suiteRepo, toCsv } = require("./suite-timings.js");

/* A guess inside #4579's bound of a day behind the newest green run: four
 * checks a day, each a listing and at most one download. */
const CHECK_MS = 6 * 60 * 60 * 1000;
/* Untraced: more than the refreshes one lander batch can straddle. */
const KEPT = 5;
const STAMP = "checked";
const HELD = /^(\d+)\.csv$/;

/**
 * @typedef {{ file: string|null, failed: string|null }} Timings
 *   `file` the newest held timings, null where none is; `failed` why this
 *   read's check failed, null where it passed or none was due
 * @typedef {(root: string, held: (run: number) => boolean) =>
 *   { run: number, sha: string, rows: ReturnType<typeof import("./suite-timings.js").readReports>|null }|null} Fetch
 */

/** @type {Fetch} */
const fetchNewest = (root, held) =>
	newestRun(suiteRepo(root), Date.now(), root, held);

/**
 * The run ids `dir` holds, newest first.
 * @param {string} dir
 * @returns {number[]}
 */
function heldRuns(dir) {
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
 * Whether the last check is CHECK_MS old or there was none; marks a check
 * as begun where it is.
 * @param {string} dir
 * @param {number} now
 */
function checkDue(dir, now) {
	const stamp = path.join(dir, STAMP);
	try {
		if (now - fs.statSync(stamp).mtimeMs < CHECK_MS) return false;
	} catch {
		/* No stamp: never checked. */
	}
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(stamp, "");
	const at = new Date(now);
	fs.utimesSync(stamp, at, at);
	return true;
}

/**
 * The newest run's file written into `dir` where not yet held, and all but
 * the newest KEPT dropped.
 * @param {string} dir
 * @param {string} root
 * @param {Fetch} fetch
 */
function refresh(dir, root, fetch) {
	const found = fetch(root, (run) =>
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
	for (const run of heldRuns(dir).slice(KEPT))
		fs.rmSync(path.join(dir, `${run}.csv`), { force: true });
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
		if (checkDue(dir, now)) refresh(dir, root, fetch);
	} catch (error) {
		failed = caught(error).message.trim();
	}
	const [newest] = heldRuns(dir);
	return {
		file: newest === undefined ? null : path.join(dir, `${newest}.csv`),
		failed,
	};
}

module.exports = { CHECK_MS, latestTimings };
