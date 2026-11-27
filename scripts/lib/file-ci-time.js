const { FILE_LIMIT_MS } = require("./suite-ceiling.js");

// guess, workflow-core#4283
const SWEEPS_JUDGED = 3;
// guess, workflow-core#5529
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

/** @param {Sweep[]} sweeps */
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

/** @param {Sweep[]} sweeps */
function wantsOlder(sweeps) {
	if (sweeps.length < SWEEPS_JUDGED) return true;
	for (const r of readingsByFile(sweeps).values())
		if (r.length < SWEEPS_JUDGED) return true;
	return false;
}

/**
 * @param {string[]} runs
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
 * @param {Sweep[]} sweeps
 * @returns {{ judged: false, runs: string[] }
 *   | { judged: true, runs: string[], over: FileTime[], unjudged: Unjudged[] }}
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

/** @param {string[]} runs */
const judgedNothing = (runs) =>
	`judged nothing: ${runs.length} sweep(s) with vitest reports readable${runs.length > 0 ? ` (${runs.join(", ")})` : ""}, ${SWEEPS_JUDGED} needed for a median.`;

module.exports = {
	SWEEPS_JUDGED,
	collect,
	judge,
	judgedNothing,
	median,
	readingsByFile,
};
