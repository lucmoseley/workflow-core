const fs = require("node:fs");
const path = require("node:path");

const { configDirs } = require("./arbiter-store");
const { orFallback } = require("./caught.js");
const { readJsonl } = require("./jsonl.js");
const { markersDir } = require("./marker-root.js");

/**
 * @typedef {object} RootReading
 * @property {string} dir
 * @property {"absent" | "unreadable" | "ok"} state
 * @property {number | null} oldestMs
 * @property {number | null} lineCount
 */

/** @type {() => string} */
const WATCH_FILE = () =>
	process.env.WFC_HISTORY_TRIM_WATCH ||
	path.join(markersDir(), ".history-trim-watch.jsonl");

/** @type {(watchFile: string) => string} */
const RECORD_STAMP = (watchFile) => `${watchFile}.stamp`;

// guess, workflow-core#2617
const RECORD_MIN_AGE_HOURS = 24;

/**
 * @param {string} seatDir
 * @returns {RootReading}
 */
function readRoot(seatDir) {
	const dir = path.basename(seatDir);
	const file = path.join(seatDir, "history.jsonl");
	let read;
	try {
		read = readJsonl(file);
	} catch {
		return { dir, state: "unreadable", oldestMs: null, lineCount: null };
	}
	if (!read) return { dir, state: "absent", oldestMs: null, lineCount: null };
	const lineCount = new Set([
		...read.entries.map((e) => e.line),
		...read.bad,
		...read.zeroed,
	]).size;
	let oldestMs = null;
	for (const row of read.rows) {
		const t = row.timestamp;
		if (
			typeof t === "number" &&
			Number.isFinite(t) &&
			(oldestMs === null || t < oldestMs)
		)
			oldestMs = t;
	}
	if (lineCount > 0 && oldestMs === null)
		return { dir, state: "unreadable", oldestMs: null, lineCount: null };
	return { dir, state: "ok", oldestMs, lineCount };
}

/**
 * @param {string[]} [dirs]
 * @returns {RootReading[]}
 */
function readRoots(dirs = configDirs()) {
	return dirs.map(readRoot);
}

/**
 * @param {string} [watchFile]
 * @returns {Record<string, RootReading> | null | undefined}
 */
function readBaseline(watchFile = WATCH_FILE()) {
	let read;
	try {
		read = readJsonl(watchFile);
	} catch {
		return;
	}
	if (!read) return null;
	const newest = read.entries.at(-1);
	const lastLost = Math.max(read.bad.at(-1) ?? 0, read.zeroed.at(-1) ?? 0);
	if (lastLost > (newest?.line ?? 0)) return;
	if (!newest) return null;
	const last = newest.row;
	/** @type {Record<string, RootReading>} */
	const byDir = {};
	for (const r of /** @type {RootReading[]} */ (last.roots || [])) {
		if (r && typeof r.dir === "string") byDir[r.dir] = r;
	}
	return byDir;
}

/**
 * @param {RootReading[]} current
 * @param {Record<string, RootReading> | null | undefined} baseline
 * @returns {{ dir: string, priorOldestMs: number, newOldestMs: number }[]}
 */
function trimmedRoots(current, baseline) {
	if (baseline === null || baseline === undefined) return [];
	/** @type {{ dir: string, priorOldestMs: number, newOldestMs: number }[]} */
	const out = [];
	for (const r of current) {
		if (r.state !== "ok" || r.oldestMs === null) continue;
		const prior = baseline[r.dir];
		if (prior?.state !== "ok" || prior.oldestMs === null) continue;
		if (r.oldestMs > prior.oldestMs)
			out.push({
				dir: r.dir,
				priorOldestMs: prior.oldestMs,
				newOldestMs: r.oldestMs,
			});
	}
	return out;
}

/**
 * @param {RootReading[]} roots
 * @param {number} now
 * @param {string} [watchFile]
 * @returns {"recorded" | "throttled" | "failed"}
 */
function recordReading(roots, now, watchFile = WATCH_FILE()) {
	const stamp = RECORD_STAMP(watchFile);
	const last = orFallback(
		() => Date.parse(fs.readFileSync(stamp, "utf8").trim()),
		Number.NaN,
	);
	if (Number.isFinite(last) && (now - last) / 36e5 < RECORD_MIN_AGE_HOURS)
		return "throttled";
	try {
		fs.writeFileSync(stamp, `${new Date(now).toISOString()}\n`);
	} catch {
		return "failed";
	}
	const reading = { at: new Date(now).toISOString(), roots };
	try {
		fs.appendFileSync(watchFile, `${JSON.stringify(reading)}\n`);
		return "recorded";
	} catch {
		return "failed";
	}
}

module.exports = {
	WATCH_FILE,
	readBaseline,
	readRoots,
	recordReading,
	trimmedRoots,
};
