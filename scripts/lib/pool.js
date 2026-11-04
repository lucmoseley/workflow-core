/*
 * pool.js — run an async job over each item, at most `width` at once, the
 * results in the items' order (#4311). One bounded fan-out for every program
 * that starts several children at once, so none starts them all against the
 * shared memory cap: status-report.js's checkers and check-primitives.js's
 * breach counts.
 */

/**
 * @template T, R
 * @param {ReadonlyArray<T>} items
 * @param {number} width
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function pool(items, width, fn) {
	/** @type {R[]} */
	const results = new Array(items.length);
	// One iterator shared by every worker, so each item is taken exactly once.
	const queue = items.entries();
	await Promise.all(
		Array.from({ length: Math.min(width, items.length) }, async () => {
			for (const [i, item] of queue) results[i] = await fn(item);
		}),
	);
	return results;
}

module.exports = { pool };
