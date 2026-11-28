const { DAY_MS } = require("./retained-jsonl.js");

const WAITING_LABEL = "waiting:external";
// guess, #5840
const AGE_UNIT_DAYS = 7;

/**
 * @param {string|undefined|null} createdAt
 * @param {number} now
 */
function agePointsOf(createdAt, now) {
	const age = now - Date.parse(createdAt ?? "");
	return Number.isFinite(age)
		? Math.max(0, Math.floor(age / (AGE_UNIT_DAYS * DAY_MS)))
		: 0;
}

/**
 * @typedef {object} SortLevels
 * @property {boolean} bug
 * @property {boolean} urgent
 * @property {boolean} goal
 * @property {number} stallDays
 * @property {boolean} asksQuestions
 * @property {number} depth
 * @property {number} closes
 * @property {number} agePoints
 * @property {number} reach
 * @property {boolean|number} collision
 */

/**
 * @typedef {Omit<SortLevels, "collision"> & {number: number, createdAt?: string, collision: string}} FrontierRow
 */

/**
 * @typedef {object} RepoFrontier
 * @property {string} root
 * @property {number|null} lastLaunchAt
 * @property {FrontierRow[]} rows
 * @property {import("./retro-bundles.js").RetroLaunch[]} retroBundles
 */

/**
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
		b.depth + b.closes + b.agePoints - (a.depth + a.closes + a.agePoints) ||
		b.reach - a.reach ||
		Number(a.collision) - Number(b.collision)
	);
}

/**
 * @typedef {Pick<SortLevels, "bug" | "urgent" | "goal" | "depth">} Inherited
 */

/**
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
	/** @param {FrontierRow} a @param {FrontierRow} b */
	const byAge = (a, b) =>
		Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? "") || 0;
	const frontier = tagged
		.sort(
			(a, b) =>
				compareLevels(levels(a.row), levels(b.row)) ||
				byAge(a.row, b.row) ||
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

module.exports = {
	AGE_UNIT_DAYS,
	agePointsOf,
	WAITING_LABEL,
	compareLevels,
	joinInherited,
	mergeFrontiers,
};
