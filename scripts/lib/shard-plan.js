/**
 * @param {{ file: string, seconds: number|null }[]} rows
 * @returns {Map<string, number>}
 */
function secondsByFile(rows) {
	/** @type {Map<string, number>} */
	const seconds = new Map();
	for (const r of rows) if (r.seconds !== null) seconds.set(r.file, r.seconds);
	return seconds;
}

/** @param {number[]} values */
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
 * @param {string[]} files
 * @param {Map<string, number>} seconds
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
 * @param {string[]} files
 * @param {Map<string, number>} seconds
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
