/*
 * frontier-order.js — the shortlist's sort levels, shared by pick-next.js,
 * which ranks one repo's frontier, and lib/refill-frontier.js, which merges
 * every included repo's (workflow-core#2003).
 */

/**
 * @typedef {object} SortLevels
 * @property {boolean} bug an open `bug`, or holding one out, urgent whether
 *   labelled or not
 * @property {boolean} urgent `urgent` on the issue, on an issue it holds out,
 *   or on an ancestor map; or a bug
 * @property {boolean} goal in the run's goal set, or holding a member out
 * @property {number} stallDays 0 unless a stalled wait
 * @property {boolean} asksQuestions
 * @property {number} depth the longest chain to the highest tier it holds out
 * @property {number} reach
 * @property {boolean|number} collision writes repo files
 */

/**
 * One pick-next `--json` frontier row, as far as the merge reads it.
 * @typedef {Omit<SortLevels, "collision"> & {number: number, collision: string}} FrontierRow
 */

/**
 * @typedef {object} RepoFrontier
 * @property {string} root
 * @property {number|null} lastLaunchAt ms; null where it never launched
 * @property {FrontierRow[]} rows
 * @property {import("./retro-bundles.js").RetroLaunch[]} retroBundles each
 *   launches as one session with its own prompt, never member by member
 */

/**
 * Lexicographic, highest first: bug → urgent → goal set → stalled wait →
 * ticket type → chain depth → reach → collision (comment-only first). 0 on a full tie, so
 * each caller appends its own tie-break.
 * @param {SortLevels} a
 * @param {SortLevels} b
 */
function compareLevels(a, b) {
	return (
		Number(b.bug) - Number(a.bug) ||
		Number(b.urgent) - Number(a.urgent) ||
		Number(b.goal) - Number(a.goal) ||
		b.stallDays - a.stallDays ||
		Number(b.asksQuestions) - Number(a.asksQuestions) ||
		b.depth - a.depth ||
		b.reach - a.reach ||
		Number(a.collision) - Number(b.collision)
	);
}

/**
 * The levels an issue inherits from what it holds out (workflow-core#3222).
 * @typedef {Pick<SortLevels, "bug" | "urgent" | "goal" | "depth">} Inherited
 */

/**
 * `a` with what `b` passes it: each tier joined, the deeper chain kept.
 * @template {Inherited} A
 * @param {A} a
 * @param {Inherited} b
 * @returns {A}
 */
const joinInherited = (a, b) => ({
	...a,
	bug: a.bug || b.bug,
	urgent: a.urgent || b.urgent,
	goal: a.goal || b.goal,
	depth: Math.max(a.depth, b.depth),
});

/**
 * Every repo's rows in one ranking, and its retro bundles in one list, each
 * tagged with its `root`. Below collision, the repo launched least recently
 * wins, a never-launched one first.
 * @param {RepoFrontier[]} repos
 */
function mergeFrontiers(repos) {
	const tagged = repos.flatMap((r) =>
		r.rows.map((row) => ({
			row,
			root: r.root,
			launched: r.lastLaunchAt ?? Number.NEGATIVE_INFINITY,
		})),
	);
	/** @param {FrontierRow} row */
	const levels = (row) => ({
		...row,
		collision: row.collision !== "comment-only",
	});
	const frontier = tagged
		.sort(
			(a, b) =>
				compareLevels(levels(a.row), levels(b.row)) ||
				a.launched - b.launched ||
				a.row.number - b.row.number ||
				a.root.localeCompare(b.root),
		)
		.map(({ row, root }) => ({ root, ...row }));
	const retroBundles = repos.flatMap((r) =>
		r.retroBundles.map((b) => ({ root: r.root, ...b })),
	);
	return { frontier, retroBundles };
}

module.exports = { compareLevels, joinInherited, mergeFrontiers };
