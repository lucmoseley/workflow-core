const fs = require("node:fs");
const path = require("node:path");
const { ignoreFailure } = require("./caught.js");
const { parseJsonl } = require("./jsonl.js");

const { configDirs } = require("./arbiter-store");
const { readSeatProjectDirs } = require("./project-dirs");

/** @typedef {import("./transcript.js").TranscriptRecord} TranscriptRecord */

const HOUR_MS = 36e5;
const DAY_MS = 864e5;

// guess, lucmoseley/mantahostels#1362: fitted against one event
const MIN_DEAD_HOURS = 20;
// guess, lucmoseley/mantahostels#1362: fitted against one event
const FLANK_RATIO = 0.65;

// lucmoseley/mantahostels#1362 guess
const FLANK_HOURS = 3;

const TRAILING_DAYS = 7;
const BUSY_HOURS = 24;

// guess, lucmoseley/mantahostels#1362: the cut its research note enumerated fourteen candidates at
const CANDIDATE_MIN_HOURS = 10;

/** @param {string[]} [seats] @returns {string[]} */
function readCorpusRoots(seats = configDirs()) {
	return readSeatProjectDirs(seats).dirs;
}

/** @param {string[]} roots @returns {string[]} */
function corpusFiles(roots) {
	/** @type {Set<string>} */
	const seen = new Set();
	/** @param {string} dir */
	const walk = (dir) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name.endsWith(".jsonl")) {
				ignoreFailure(() => seen.add(fs.realpathSync(full)));
			}
		}
	};
	for (const root of roots) walk(root);
	return [...seen];
}

/** @param {string} text @returns {Array<[number, string]>} */
function turnsIn(text) {
	/** @type {Array<[number, string]>} */
	const out = [];
	for (const record of /** @type {TranscriptRecord[]} */ (
		parseJsonl(text).rows
	)) {
		if (record.type !== "assistant") continue;
		const usage = record.message?.usage;
		const id = record.message?.id;
		if (!usage || !id) continue;
		const ms = Date.parse(record.timestamp);
		if (!Number.isFinite(ms)) continue;
		out.push([
			ms,
			`${id}|${usage.output_tokens || 0}|${usage.cache_creation_input_tokens || 0}`,
		]);
	}
	return out;
}

/** @param {string[]} files @returns {number[]} */
function readCorpus(files) {
	const seen = new Map();
	for (const file of files) {
		let text;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const [ms, key] of turnsIn(text)) {
			const prior = seen.get(key);
			if (prior === undefined || ms < prior) seen.set(key, ms);
		}
	}
	return [...seen.values()].sort((a, b) => a - b);
}

/** @param {number[]} turns @returns {Map<number, number>} */
function hourlyCounts(turns) {
	const hist = new Map();
	for (const ms of turns) {
		const bucket = Math.floor(ms / HOUR_MS);
		hist.set(bucket, (hist.get(bucket) || 0) + 1);
	}
	return hist;
}

/**
 * @param {Map<number, number>} hist
 * @param {number} at
 * @returns {number | null}
 */
function trailingBusyRate(hist, at) {
	const lastBucket = Math.floor(at / HOUR_MS);
	const firstBucket = Math.floor((at - TRAILING_DAYS * DAY_MS) / HOUR_MS);
	const busy = [];
	for (let b = firstBucket; b < lastBucket; b++) {
		const n = hist.get(b) || 0;
		if (n > 0) busy.push(n);
	}
	if (busy.length < BUSY_HOURS) return null;
	busy.sort((a, b) => b - a);
	const [upper, lower] = busy.slice(BUSY_HOURS / 2 - 1, BUSY_HOURS / 2 + 1);
	if (upper === undefined || lower === undefined)
		throw new Error(`${busy.length} busy hours hold no middle pair`);
	return (upper + lower) / 2;
}

/**
 * @param {number[]} turns
 * @param {number} at
 * @param {"before" | "after"} side
 * @returns {number}
 */
function flankRate(turns, at, side) {
	const span = FLANK_HOURS * HOUR_MS;
	const lo = side === "before" ? at - span : at;
	const hi = side === "before" ? at : at + span;
	let n = 0;
	for (const ms of turns) {
		if (side === "before" ? ms <= lo : ms < lo) continue;
		if (side === "before" ? ms > hi : ms >= hi) break;
		n++;
	}
	return n / FLANK_HOURS;
}

/**
 * @param {number[]} turns
 * @param {number} [minHours]
 * @returns {Array<{start: number, end: number, hours: number, before: number, after: number, baseline: number | null, beforeRatio: number | null, afterRatio: number | null}>}
 */
function deadWindows(turns, minHours = CANDIDATE_MIN_HOURS) {
	const hist = hourlyCounts(turns);
	const out = [];
	/** @type {number | null} */
	let prev = null;
	for (const end of turns) {
		const start = prev;
		prev = end;
		if (start === null) continue;
		const hours = (end - start) / HOUR_MS;
		if (hours < minHours) continue;
		const before = flankRate(turns, start, "before");
		const after = flankRate(turns, end, "after");
		const baseline = trailingBusyRate(hist, start);
		out.push({
			start,
			end,
			hours,
			before,
			after,
			baseline,
			beforeRatio: baseline === null ? null : before / baseline,
			afterRatio: baseline === null ? null : after / baseline,
		});
	}
	return out;
}

/**
 * @param {ReturnType<typeof deadWindows>} windows
 * @returns {ReturnType<typeof deadWindows>}
 */
function episodes(windows) {
	return windows.filter(
		(w) =>
			w.hours >= MIN_DEAD_HOURS &&
			w.beforeRatio !== null &&
			w.afterRatio !== null &&
			w.beforeRatio >= FLANK_RATIO &&
			w.afterRatio >= FLANK_RATIO,
	);
}

module.exports = {
	DAY_MS,
	CANDIDATE_MIN_HOURS,
	FLANK_HOURS,
	FLANK_RATIO,
	MIN_DEAD_HOURS,
	corpusFiles,
	readCorpusRoots,
	deadWindows,
	episodes,
	hourlyCounts,
	readCorpus,
	trailingBusyRate,
};
