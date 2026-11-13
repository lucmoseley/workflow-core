/*
 * doc-map-gate-markers.js — the lines of check-doc-map.js's report that open
 * each block the pre-commit doc-map gate replays (#5155). Its caller is
 * lib/doc-map-gate-report.js; doc-map-gate-report.test.ts pins every marker on
 * wording the checker still emits.
 *
 * THE MARKERS MATCH check-doc-map.js's OWN WORDING. Each untracked block has
 * its own marker: one matching both would slice whichever came first and judge
 * a route's `C36 → path` item against Section A's wording.
 */

/** The WARN blocks replayed alone, in replay order: assertions 22, 23, 24. */
const REPLAY_MARKERS = [
	/marked over cap by ruling grew in/,
	/look like an over-cap marker but do not parse as one:$/,
	/lost the marker the baseline carried:$/,
];

/** The untracked blocks, Section A's first. */
const UNTRACKED_BLOCKS = [
	{
		marker: /register entr.* not yet tracked by git:$/,
		noun: "Section A row(s)",
		fix: "name the file in this commit's pathspec too, or drop the row until it lands.",
	},
	{
		marker: /Section C route path.* not yet tracked by git:$/,
		noun: "Section C route(s)",
		fix: "name the file in this commit's pathspec too, or drop the route until it lands.",
	},
];

module.exports = { REPLAY_MARKERS, UNTRACKED_BLOCKS };
