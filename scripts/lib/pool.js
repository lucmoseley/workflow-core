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
	const queue = items.entries();
	await Promise.all(
		Array.from({ length: Math.min(width, items.length) }, async () => {
			for (const [i, item] of queue) results[i] = await fn(item);
		}),
	);
	return results;
}

module.exports = { pool };
