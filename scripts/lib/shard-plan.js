/*
 * shard-plan.js — which test files a `--shard=k/n` run takes, packed by each
 * file's recorded seconds so every shard finishes at about the same time
 * (#2413). scripts/vitest-shard-sequencer.ts is the seam vitest calls.
 *
 * LONGEST FIRST, EACH TO THE LIGHTEST SHARD (greedy LPT). A file no dataset
 * row names is charged the dataset's median.
 *
 * DETERMINISTIC ON PURPOSE: every shard job computes the whole plan on its own
 * and keeps its slice, so the same files and dataset must give the same plan
 * on every runner, or a file would run twice or never. Ties break on path,
 * never on input order.
 */

/**
 * @param {{ file: string, seconds: number|null }[]} rows a parsed dataset's rows
 * @returns {Map<string, number>} each timed file's seconds
 */
function secondsByFile(rows) {
	/** @type {Map<string, number>} */
	const seconds = new Map();
	for (const r of rows) if (r.seconds !== null) seconds.set(r.file, r.seconds);
	return seconds;
}

/**
 * @param {number[]} values
 * Where nothing is timed every file is charged the same, so any positive
 * charge gives one plan: files dealt out in path order.
 */
function median(values) {
	if (values.length === 0) return 1;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const upper = sorted[mid];
	const lower = sorted.length % 2 ? upper : sorted[mid - 1];
	if (upper === undefined || lower === undefined)
		throw new Error(`no middle value in ${sorted.length} timings`);
	return (lower + upper) / 2;
}

/**
 * Files by their charge, heaviest first: their recorded seconds, or the
 * median where they have none.
 * @param {string[]} files repo-relative paths
 * @param {Map<string, number>} seconds from secondsByFile
 * @returns {[string, number][]}
 */
function heaviestFirst(files, seconds) {
	const fallback = median([...seconds.values()]);
	return files
		.map(
			(f) => /** @type {[string, number]} */ ([f, seconds.get(f) ?? fallback]),
		)
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : Number(a[0] > b[0])));
}

/**
 * The files shard `index` of `count` runs, 1-based as `--shard` spells it.
 * @param {string[]} files repo-relative paths
 * @param {Map<string, number>} seconds from secondsByFile
 * @param {number} index
 * @param {number} count
 * @returns {string[]}
 */
function planShard(files, seconds, index, count) {
	/** @type {number[]} */
	const loads = Array.from({ length: count }, () => 0);
	/** @type {string[]} */
	const mine = [];
	for (const [file, s] of heaviestFirst(files, seconds)) {
		const least = Math.min(...loads);
		const lightest = loads.indexOf(least);
		loads[lightest] = least + s;
		if (lightest === index - 1) mine.push(file);
	}
	return mine;
}

module.exports = { heaviestFirst, planShard, secondsByFile };
