/*
 * frontier-order.js — the shortlist's sort levels, shared by pick-next.js,
 * which ranks one repo's frontier, and lib/refill-frontier.js, which merges
 * every included repo's (#2003).
 */

/**
 * @typedef {object} SortLevels
 * @property {boolean} urgent a fresh `urgent`
 * @property {boolean} goal in the run's goal set
 * @property {number} stallDays 0 unless a stalled wait
 * @property {boolean} asksQuestions
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
 * Lexicographic, highest first: fresh urgent → goal set → stalled wait →
 * ticket type → reach → collision (comment-only first). 0 on a full tie, so
 * each caller appends its own tie-break.
 * @param {SortLevels} a
 * @param {SortLevels} b
 */
function compareLevels(a, b) {
	return (
		Number(b.urgent) - Number(a.urgent) ||
		Number(b.goal) - Number(a.goal) ||
		b.stallDays - a.stallDays ||
		Number(b.asksQuestions) - Number(a.asksQuestions) ||
		b.reach - a.reach ||
		Number(a.collision) - Number(b.collision)
	);
}

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

module.exports = { compareLevels, mergeFrontiers };
