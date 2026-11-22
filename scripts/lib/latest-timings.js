const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { gitCommonDir } = require("./git.js");
const { readNewestRun, readSuiteRepo, toCsv } = require("./suite-timings.js");

const HOUR_MS = 60 * 60 * 1000;
// guess, #4579
const CHECK_MS = 6 * HOUR_MS;
// guess, #4579
const RETRY_MS = HOUR_MS / 2;
// #4579
const STALE_MS = 24 * HOUR_MS;
// guess, #4579
const KEPT = 5;
const ATTEMPTED = "attempted";
const PASSED = "passed";
const HELD = /^(\d+)\.csv$/;

/**
 * @typedef {{ file: string|null, failed: string|null }} Timings
 * @typedef {(root: string, now: number, held: (run: number) => boolean) =>
 *   ReturnType<typeof readNewestRun>} Fetch
 */

/** @type {Fetch} */
const fetchNewest = (root, now, held) =>
	readNewestRun(readSuiteRepo(root), now, root, held);

/**
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
 * @param {string} root
 * @param {{ now?: number, fetch?: Fetch }} [seams]
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
