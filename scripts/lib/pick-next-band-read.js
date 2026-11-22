const fs = require("node:fs");
const nodePath = require("node:path");
const { parseErrLine } = require("./gh.js");
const writeSetCache = require("./write-set-cache.js");
const writeSetPredict = require("./write-set-predict.js");

/** @typedef {import("./pick-next-collisions.js").TrackedFiles} TrackedFiles */
/** @typedef {import("./pick-next-verdict.js").Issue} Issue */

/**
 * @typedef {object} StoredEntry
 * @property {string[]} writeSet
 * @property {string|null} [sizeBand]
 * @property {string|null} [gist]
 * @property {string} [derivedAt]
 * @property {string|null} [predictedSize]
 */

/** @typedef {StoredEntry & {number: number, provisional: boolean, unrevalidated: boolean, replaced?: string|null}} CacheEntry */

/**
 * @typedef {object} CacheMiss
 * @property {number} number
 * @property {string} state
 * @property {string} bodyHash
 * @property {string[]|null} gonePaths
 */

/** @typedef {{warm: CacheEntry[], cold: CacheMiss[]}} CacheSplit */

/**
 * @param {string} root
 * @param {Issue[]} frontier
 * @param {{ tracked: TrackedFiles, split: CacheSplit, enabled: boolean }} opts
 */
function prewarm(root, frontier, { tracked, split, enabled }) {
	const warm = split.warm.filter((w) => !w.provisional);
	const provisional = split.warm.filter((w) => w.provisional);
	if (!enabled)
		return { warm, provisional, cold: split.cold, skipped: [], enabled };

	const byNumber = new Map(frontier.map((i) => [i.number, i]));
	const cold = [];
	const skipped = [];
	for (const miss of split.cold) {
		const issue = byNumber.get(miss.number);
		const r = issue
			? writeSetPredict.storeProvisional(root, issue, tracked)
			: { ok: false, why: "not on the frontier this run read" };
		if (!r.ok) {
			cold.push(miss);
			skipped.push({ number: miss.number, why: r.why });
			continue;
		}
		provisional.push({
			number: miss.number,
			.../** @type {StoredEntry} */ (r.entry),
			provisional: true,
			unrevalidated: false,
			replaced: miss.state,
		});
	}
	return { warm, provisional, cold, skipped, enabled };
}

/**
 * @param {string} dir
 * @param {{number: number, title: string, body: string}[]} list
 */
function dumpBodies(dir, list) {
	try {
		fs.mkdirSync(dir, { recursive: true });
		for (const i of list)
			fs.writeFileSync(
				nodePath.join(dir, `${i.number}.md`),
				`# #${i.number} — ${i.title}\n\n<!-- body-hash: ${writeSetCache.bodyHash(i.body)} -->\n\n${i.body}\n`,
			);
		return { ok: true, dir, count: list.length };
	} catch (e) {
		return { ok: false, dir, count: 0, error: parseErrLine(e) };
	}
}

/**
 * @param {{nominated: unknown[]}} graph
 * @param {{cold: unknown[]}} cacheState
 * @returns {boolean}
 */
function bandReadRequiredOf(graph, cacheState) {
	return graph.nominated.length > 0 || cacheState.cold.length > 0;
}

module.exports = { bandReadRequiredOf, dumpBodies, prewarm };
