/*
 * history-trim.js — reading each seat's `~/.claudeN/history.jsonl` for the
 * two numbers that reveal silent trimming: the oldest surviving line's
 * timestamp, and the line count. mantahostels#2617.
 *
 * Per-seat burn attribution (mantahostels#2607, scripts/measure-burn/scan_burn.py) rests
 * entirely on these files. Nothing archives them and no retention cap is
 * documented, so a root that starts dropping lines shrinks the retroactive
 * corpus with no signal at all — and the shrink is unrecoverable. This module
 * is the DETECTOR only, per mantahostels#2607's ruling: an archiver is worth building once
 * trimming is a dated fact rather than a hypothesis.
 *
 * THREE STATES A ROOT CAN BE IN, distinguished from a genuine trim:
 *
 *   ABSENT     no `history.jsonl` at this root at all — a seat that was never
 *              provisioned.
 *   NEW        the file reads fine, but the baseline holds no prior entry for
 *              this root — the first time it has been seen, so there is
 *              nothing to compare against yet.
 *   UNREADABLE the file exists but cannot be read, or every line in it fails
 *              to parse a numeric `timestamp` — a permission error or a
 *              half-written file, not evidence either way.
 *
 * TRIMMED is reported only where a root is none of the above AND its oldest
 * timestamp has moved forward — strictly increased — since the last
 * recording. A falling line count with the same oldest timestamp is not
 * trimming by this signature: a session simply stopped, which is not loss.
 */

const fs = require("node:fs");
const path = require("node:path");

const { configDirs } = require("./arbiter-store");
const { hostRoot } = require("./host-root.js");
const { caught } = require("./caught.js");

/**
 * One root's reading.
 *
 * @typedef {object} RootReading
 * @property {string} dir
 * @property {"absent" | "unreadable" | "ok"} state
 * @property {number | null} oldestMs
 * @property {number | null} lineCount
 */

/** @type {() => string} */
const WATCH_FILE = () =>
	process.env.WFC_HISTORY_TRIM_WATCH ||
	path.join(hostRoot(), "docs", "data", "history-trim-watch.jsonl");

/** The stamp is gitignored: it is bookkeeping for the throttle, not part of
 *  the tracked watch file's record. */
/** @type {(watchFile: string) => string} */
const RECORD_STAMP = (watchFile) => `${watchFile}.stamp`;

/** One reading a day, matching seat-utilisation's own throttle. The watch file
 *  is TRACKED, so every line it appends is committed: several
 *  `npm run status` runs in one day would each append a reading identical to
 *  the last but for its timestamp, growing the file without narrowing when a
 *  trim happened. */
const RECORD_MIN_AGE_HOURS = 24;

/**
 * Read one root's `history.jsonl`.
 *
 * @param {string} seatDir
 * @returns {RootReading}
 */
function readRoot(seatDir) {
	const dir = path.basename(seatDir);
	const file = path.join(seatDir, "history.jsonl");
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (caught(e).code === "ENOENT")
			return { dir, state: "absent", oldestMs: null, lineCount: null };
		return { dir, state: "unreadable", oldestMs: null, lineCount: null };
	}
	const lines = text.split("\n").filter((l) => l.trim() !== "");
	let oldestMs = null;
	for (const line of lines) {
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			/* one malformed line is not evidence the file is unreadable — skip it
			 * and keep looking; only the all-garbage case below gives up. */
			continue;
		}
		const t = parsed?.timestamp;
		if (
			typeof t === "number" &&
			Number.isFinite(t) &&
			(oldestMs === null || t < oldestMs)
		)
			oldestMs = t;
	}
	/* A file that exists, has lines, but yields no parseable timestamp at all
	 * cannot support the trimming signature — treated as unreadable rather
	 * than as a root with nothing old in it. An empty file (0 lines) is a
	 * real, if degenerate, reading: oldestMs null, lineCount 0. */
	if (lines.length > 0 && oldestMs === null)
		return { dir, state: "unreadable", oldestMs: null, lineCount: null };
	return { dir, state: "ok", oldestMs, lineCount: lines.length };
}

/**
 * Every seat root's reading.
 *
 * @param {string[]} [dirs] the seat directories, arbiter-store's set by default
 * @returns {RootReading[]}
 */
function readRoots(dirs = configDirs()) {
	return dirs.map(readRoot);
}

/**
 * The last recorded reading per root, from the watch file's newest line.
 *
 * NULL AND UNDEFINED ARE NOT THE SAME ANSWER. `null` is "no baseline yet" —
 * ENOENT, or a file with no lines — a legitimate first-ever run. `undefined`
 * is "a baseline exists and could not be read" — a permission error, or a
 * newest line that fails to parse. The watch file is TRACKED, so the second
 * case is this checker's own apparatus failing on repo bytes, never the
 * subject: silently reading it as "no baseline" would re-baseline over
 * whatever trim happened in the gap, the one failure mode this detector
 * exists to catch.
 *
 * @param {string} [watchFile]
 * @returns {Record<string, RootReading> | null | undefined}
 */
function readBaseline(watchFile = WATCH_FILE()) {
	let text;
	try {
		text = fs.readFileSync(watchFile, "utf8");
	} catch (e) {
		return caught(e).code === "ENOENT" ? null : undefined;
	}
	const lines = text.split("\n").filter((l) => l.trim() !== "");
	const lastLine = lines.at(-1);
	if (lastLine === undefined) return null;
	let last;
	try {
		last = JSON.parse(lastLine);
	} catch {
		return;
	}
	/** @type {Record<string, RootReading>} */
	const byDir = {};
	for (const r of last.roots || []) {
		if (r && typeof r.dir === "string") byDir[r.dir] = r;
	}
	return byDir;
}

/**
 * Compare this reading against the last recorded one.
 *
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
 * Append this reading to the watch file, at most once every
 * RECORD_MIN_AGE_HOURS — the stamp is taken BEFORE the append, so a failed
 * stamp cancels the record rather than leaving the throttle unset on a
 * read-only disk (matching recordReading() in lib/seat-utilisation.js).
 *
 * @param {RootReading[]} roots
 * @param {number} now
 * @param {string} [watchFile]
 * @returns {"recorded" | "throttled" | "failed"}
 */
function recordReading(roots, now, watchFile = WATCH_FILE()) {
	const stamp = RECORD_STAMP(watchFile);
	try {
		const last = Date.parse(fs.readFileSync(stamp, "utf8").trim());
		if (Number.isFinite(last) && (now - last) / 36e5 < RECORD_MIN_AGE_HOURS)
			return "throttled";
	} catch {
		/* no stamp yet, or an unreadable one: a reading is due */
	}
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
