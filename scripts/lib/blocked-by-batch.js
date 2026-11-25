const { readLinksMany, readRestLinks, restRow } = require("./link-batch.js");
const { isInOtherRepo } = require("./issue-ref.js");

/** @typedef {import("./blocker-graph").Edge} Edge */
/** @typedef {import("./blocker-graph").EdgesRead} EdgesRead */
/** @typedef {import("./link-batch").LinkRow} LinkRow */

/**
 * @param {LinkRow} row
 * @param {string|null} home
 * @param {string} [self]
 * @returns {Edge}
 */
const rowEdge = (row, home, self) => ({
	...row,
	repo: row.repo && (!self || isInOtherRepo(row, self)) ? row.repo : home,
});

/**
 * @param {any} i
 * @param {string|null} home
 * @returns {Edge}
 */
const edgeOf = (i, home) => rowEdge(restRow(i), home);

/**
 * @param {string} repo
 * @param {number} n
 * @param {{home: string|null}} opts
 * @returns {Promise<EdgesRead>}
 */
async function readBlockedByOne(repo, n, { home }) {
	const r = await readRestLinks(repo, n, "blockedBy");
	return r.ok
		? { ok: true, edges: r.rows.map((row) => rowEdge(row, home)) }
		: r;
}

/**
 * @template {{number: number}} T
 * @param {T[]} issues
 * @param {{repo: string, home: string|null, strict?: boolean}} opts
 * @returns {Promise<{issue: T, read: EdgesRead}[]>}
 */
async function blockedByMany(issues, { repo, home, strict = false }) {
	const reads = await readLinksMany(repo, issues, {
		want: ["blockedBy"],
		strict,
	});
	return reads.map(({ item, read }) => ({
		issue: item,
		read: read.ok
			? {
					ok: true,
					edges: (read.links.blockedBy ?? []).map((row) =>
						rowEdge(row, home, read.self),
					),
				}
			: read,
	}));
}

module.exports = { blockedByMany, readBlockedByOne, edgeOf };
