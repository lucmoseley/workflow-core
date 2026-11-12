/*
 * blocked-by-batch.js — many issues' native blockers as Edges, read through
 * lib/link-batch.js's batched link query (#2685, #5097).
 *
 * FAILURE IS PER BATCH, OR PER ISSUE — NEVER "NO BLOCKERS": an issue
 * link-batch could not read keeps its reason.
 */

const { readLinksMany, readRestLinks, restRow } = require("./link-batch.js");
const { isInOtherRepo } = require("./issue-ref.js");

/** @typedef {import("./blocker-graph").Edge} Edge */
/** @typedef {import("./blocker-graph").EdgesRead} EdgesRead */
/** @typedef {import("./link-batch").LinkRow} LinkRow */

/**
 * A link row as an Edge. One naming no repo, or one in `self` — the queried
 * repository's own name, so `{owner}/{repo}` and the name it resolves to
 * never read as two repos — is `home`'s.
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
 * A REST issue row as lib/blocker-graph.js reads it, a row naming no repo
 * read as `home`'s.
 * @param {any} i GitHub's REST issue JSON as parsed
 * @param {string|null} home
 * @returns {Edge}
 */
const edgeOf = (i, home) => rowEdge(restRow(i), home);

/**
 * One issue's native blockers through REST, each edge's `repo` resolved
 * against `home`.
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
 * Each of `issues`' native blockers, paired with it in input order, every
 * edge's `repo` resolved: `home` for one in `repo` itself.
 * @template {{number: number}} T
 * @param {T[]} issues issues in `repo`
 * @param {{repo: string, home: string|null, strict?: boolean}} opts
 *   `strict` refuses a REST fallback that answers empty (lib/gh.js)
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
