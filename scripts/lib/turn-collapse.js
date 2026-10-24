/*
 * turn-collapse.js — the dead-window self-throttling detector (mantahostels#1404).
 *
 * WHAT IT LOOKS FOR. Deliberate self-throttling — the founder stopping work to
 * avoid crashing at 100% of a weekly allowance — leaves no limit record: the
 * corpus carries no usage percentage and no approaching-limit warning, only the
 * session-limit and 429 records `scan_ceiling.py` already reads (mantahostels#1342). What it
 * does leave is a SHAPE: hard work, then a silence far longer than a night, then
 * hard work again.
 *
 * THE DISCRIMINATOR IS THE GAP, NOT THE DAILY COUNT. The innocent collapses in
 * the daily count are DEEPER than the real one, so no threshold ordering
 * separates them (mantahostels#1362, https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/self-throttling-turn-collapse.md).
 *
 * WHAT IT IS WORTH. Two thresholds fitted after seeing the answer, against ONE
 * event — so this reports and nothing more, and no spend-ladder trigger is wired
 * to it (ruled at mantahostels#1362). Revisit the numbers once a second episode exists.
 */

const fs = require("node:fs");
const path = require("node:path");

const { configDirs } = require("./arbiter-store");
const { seatProjectDirs } = require("./project-dirs");

const HOUR_MS = 36e5;
const DAY_MS = 864e5;

/* The two thresholds. */
const MIN_DEAD_HOURS = 20;
const FLANK_RATIO = 0.65;

/* How much work either side of the gap is read as "resumed hard". Not
 * independently derived. */
const FLANK_HOURS = 3;

/* The normaliser: the median of the busiest 24 hour-buckets in the trailing 7
 * days. Volume on this machine moves fast enough between weeks (mantahostels#1343) that an
 * unnormalised flank measures the month, not the episode. */
const TRAILING_DAYS = 7;
const BUSY_HOURS = 24;

/* The reporting floor, not a detection threshold: gaps this short can never be
 * episodes. 10 is the cut https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/self-throttling-turn-collapse.md
 * enumerated its fourteen candidates at. That table CANNOT be reproduced by a
 * later run — Claude Code rolls transcripts off at about 30 days, so the
 * artefact's July rows are already gone and the candidate count with them.
 * Nothing turns on the exact value. */
const CANDIDATE_MIN_HOURS = 10;

/**
 * Every project directory under the seats' `projects/`, realpath-deduped
 * (`lib/project-dirs.js`): a seat's directory symlinked at another's would
 * double-count every turn (mantahostels#1343).
 *
 * @param {string[]} [seats] config dirs, every known seat by default
 * @returns {string[]}
 */
function corpusRoots(seats = configDirs()) {
	return seatProjectDirs(seats).dirs;
}

/**
 * Every transcript under the given roots, deduplicated by realpath.
 *
 * RECURSIVE, because a subagent's transcript is not a sibling of its parent's:
 * it sits at `<project>/<sessionId>/subagents/agent-*.jsonl`. A flat read misses
 * every subagent turn — over half this machine's spend from August onwards.
 *
 * A project directory may be a symlink into another seat's, so the
 * deduplication is on the resolved path of each file rather than of each
 * directory.
 *
 * @param {string[]} roots
 * @returns {string[]}
 */
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
				try {
					seen.add(fs.realpathSync(full));
				} catch {
					/* vanished between readdir and realpath; nothing to read */
				}
			}
		}
	};
	for (const root of roots) walk(root);
	return [...seen];
}

/**
 * The assistant turns in one transcript, as `[epochMs, dedupKey]` pairs.
 *
 * SIDECHAINS ARE KEPT. `lib/transcript.js` skips them because a subagent's
 * context is not the session's; here every turn is spend.
 *
 * A transcript is appended to while it is read, so a half-written final line is
 * skipped rather than thrown on.
 *
 * @param {string} text
 * @returns {Array<[number, string]>}
 */
function turnsIn(text) {
	/** @type {Array<[number, string]>} */
	const out = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record.type !== "assistant") continue;
		const usage = record.message?.usage;
		const id = record.message?.id;
		if (!usage || !id) continue;
		const ms = Date.parse(record.timestamp);
		if (!Number.isFinite(ms)) continue;
		/* mantahostels#1343's key. One assistant message reaches the transcript on several
		 * lines, and the id alone also repeats across a resumed session's replayed
		 * prefix; the two usage figures are what distinguish a real second turn. */
		out.push([
			ms,
			`${id}|${usage.output_tokens || 0}|${usage.cache_creation_input_tokens || 0}`,
		]);
	}
	return out;
}

/**
 * Every deduplicated assistant turn across the corpus, as sorted epoch ms.
 *
 * @param {string[]} files
 * @returns {number[]}
 */
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
			/* Earliest wins: the same turn replayed into a resumed session's
			 * transcript carries the later file's write time in every other field,
			 * but the timestamp is the original. Keeping the minimum makes the union
			 * order-independent. */
			const prior = seen.get(key);
			if (prior === undefined || ms < prior) seen.set(key, ms);
		}
	}
	return [...seen.values()].sort((a, b) => a - b);
}

/**
 * Turns per hour-bucket, keyed by `floor(ms / 3600000)`.
 *
 * @param {number[]} turns sorted epoch ms
 * @returns {Map<number, number>}
 */
function hourlyCounts(turns) {
	const hist = new Map();
	for (const ms of turns) {
		const bucket = Math.floor(ms / HOUR_MS);
		hist.set(bucket, (hist.get(bucket) || 0) + 1);
	}
	return hist;
}

/**
 * The median of the busiest `BUSY_HOURS` hour-buckets in the `TRAILING_DAYS`
 * before `at`, or `null` where the trailing week holds fewer than `BUSY_HOURS`
 * busy hours at all.
 *
 * THE BUSY-HOUR COUNT IS THE GUARD, not the median's value. "The busiest 24
 * hours" is undefined over a week that had fewer than 24, and taking it anyway
 * yields a tiny baseline that scores a handful of turns as full-rate work — so a
 * >=20h gap at a corpus edge, or after a long break, would fire on nothing
 * (measured at mantahostels#1404). An unnormalisable flank is unknown, never strong.
 *
 * @param {Map<number, number>} hist
 * @param {number} at epoch ms
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
 * Turns per hour over the `FLANK_HOURS` ending at `at` (`before`) or starting at
 * it (`after`). Half-open on the side away from `at`, so the turn that opens or
 * closes the gap is counted and the far boundary belongs to the next window.
 *
 * @param {number[]} turns sorted epoch ms
 * @param {number} at epoch ms
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
 * Every contiguous silence of at least `minHours` between consecutive turns,
 * scored. `beforeRatio`/`afterRatio` are `null` where no baseline exists.
 *
 * @param {number[]} turns sorted epoch ms
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
		/* One baseline per window, taken at its start: the trailing 7 days either
		 * side of a 30-hour gap are the same week, and taking two would let a long
		 * gap's own emptiness deflate the after-baseline and inflate its ratio. */
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
 * The windows that fire: long enough, and strongly flanked on BOTH sides. A
 * window with no baseline never fires.
 *
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
	corpusRoots,
	deadWindows,
	episodes,
	hourlyCounts,
	readCorpus,
	trailingBusyRate,
};
