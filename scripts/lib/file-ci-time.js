/*
 * file-ci-time.js — which test files' CI time is over FILE_LIMIT_MS, judged
 * on each file's median over the last SWEEPS_JUDGED sweeps it ran in (#4292,
 * on #4283's 4 Nov ruling).
 *
 * A SWEEP IS ONE RUN OF THE SUITE WORKFLOW WITH VITEST REPORTS, whatever
 * triggered it: a `landing` push run tests the same tree a scheduled one does.
 *
 * THE FILES JUDGED are those timed in the latest SWEEPS_JUDGED sweeps. A file missing from one of them, its shard
 * cancelled say, is judged on the latest SWEEPS_JUDGED sweeps it was timed in,
 * read back to MAX_SWEEPS_READ sweeps; short of that it is unjudged.
 *
 * THE TIME IS the file's run, its beforeAll and afterAll hooks included, as
 * `scripts/lib/suite-timings.js` reads it from the reports (#4313).
 * RESIDUAL: it leaves out the file's import, which holds the worker too.
 */

const { FILE_LIMIT_MS } = require("./suite-ceiling.js");

/* The median of three, ruled with the limit on #4283. */
const SWEEPS_JUDGED = 3;
/* Untraced: two days of sweeps at four a day. */
const MAX_SWEEPS_READ = 8;

/**
 * @typedef {{ run: string, rows: { file: string, seconds: number|null }[] }} Sweep
 * @typedef {{ run: string, seconds: number }} Reading
 * @typedef {{ file: string, medianSeconds: number, readings: Reading[] }} FileTime
 * @typedef {{ file: string, readings: Reading[], overInASweep: boolean }} Unjudged
 */

/** @param {Sweep} sweep */
function timesOf(sweep) {
	/** @type {Map<string, number>} */
	const times = new Map();
	for (const r of sweep.rows)
		if (r.seconds !== null) times.set(r.file, r.seconds);
	return times;
}

/**
 * Each file timed in the latest SWEEPS_JUDGED sweeps, with its latest
 * readings, up to SWEEPS_JUDGED of them.
 * @param {Sweep[]} sweeps newest first
 */
function readingsByFile(sweeps) {
	const times = sweeps.map(timesOf);
	const files = new Set(
		times.slice(0, SWEEPS_JUDGED).flatMap((t) => [...t.keys()]),
	);
	/** @type {Map<string, Reading[]>} */
	const readings = new Map();
	for (const file of files) {
		/** @type {Reading[]} */
		const latest = [];
		for (const [i, t] of times.entries()) {
			const seconds = t.get(file);
			const sweep = sweeps[i];
			if (seconds === undefined || sweep === undefined) continue;
			latest.push({ run: sweep.run, seconds });
			if (latest.length === SWEEPS_JUDGED) break;
		}
		readings.set(file, latest);
	}
	return readings;
}

/**
 * Whether an older sweep could judge more: fewer than SWEEPS_JUDGED sweeps
 * read, or a judged file short of its readings.
 * @param {Sweep[]} sweeps newest first
 */
function wantsOlder(sweeps) {
	if (sweeps.length < SWEEPS_JUDGED) return true;
	for (const r of readingsByFile(sweeps).values())
		if (r.length < SWEEPS_JUDGED) return true;
	return false;
}

/**
 * Sweeps read newest first until no judged file is short of readings,
 * MAX_SWEEPS_READ are read, or `runs` runs out. `read` gives null for a run
 * with no reports, and `collect` lists that run under `passedOver`.
 * @param {string[]} runs newest first
 * @param {(run: string) => Sweep|null} read
 * @returns {{ sweeps: Sweep[], passedOver: string[] }}
 */
function collect(runs, read) {
	/** @type {Sweep[]} */
	const sweeps = [];
	/** @type {string[]} */
	const passedOver = [];
	for (const run of runs) {
		if (sweeps.length >= MAX_SWEEPS_READ || !wantsOlder(sweeps)) break;
		const sweep = read(run);
		if (sweep) sweeps.push(sweep);
		else passedOver.push(run);
	}
	return { sweeps, passedOver };
}

/** @param {number[]} xs */
function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const lower = s[Math.ceil(s.length / 2) - 1] ?? 0;
	const upper = s[Math.floor(s.length / 2)] ?? 0;
	return (lower + upper) / 2;
}

/**
 * @param {Sweep[]} sweeps newest first
 * @returns {{ judged: false, runs: string[] }
 *   | { judged: true, runs: string[], over: FileTime[], unjudged: Unjudged[] }}
 *   `runs` is every sweep read; `over` is slowest first
 */
function judge(sweeps) {
	const runs = sweeps.map((s) => s.run);
	if (sweeps.length < SWEEPS_JUDGED) return { judged: false, runs };
	/** @type {FileTime[]} */
	const over = [];
	/** @type {Unjudged[]} */
	const unjudged = [];
	for (const [file, readings] of readingsByFile(sweeps)) {
		if (readings.length < SWEEPS_JUDGED) {
			unjudged.push({
				file,
				readings,
				overInASweep: readings.some((r) => r.seconds * 1000 > FILE_LIMIT_MS),
			});
			continue;
		}
		const medianSeconds = median(readings.map((r) => r.seconds));
		if (medianSeconds * 1000 > FILE_LIMIT_MS)
			over.push({ file, medianSeconds, readings });
	}
	over.sort(
		(a, b) => b.medianSeconds - a.medianSeconds || a.file.localeCompare(b.file),
	);
	unjudged.sort((a, b) => a.file.localeCompare(b.file));
	return { judged: true, runs, over, unjudged };
}

module.exports = { SWEEPS_JUDGED, collect, judge };
