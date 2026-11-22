const { trimEndRun } = require("./trim-run.js");

// guess, #1769
const NAMED_PATHS_MAX = 10;

// #5153
const QUOTED_MAX = 40;

/**
 * @param {string} text
 * @param {string} key
 */
function markerField(text, key) {
	const line = text.split("\n").find((l) => l.startsWith(`${key}=`));
	return line === undefined ? null : line.slice(key.length + 1);
}

/** @param {string | null} v */
const stripped = (v) => (v ?? "").replace(/\s/g, "");

/**
 * @param {string} text
 * @param {string} key
 */
const markerList = (text, key) =>
	(markerField(text, key) ?? "")
		.split(",")
		.map((v) => v.trim())
		.filter((v) => v !== "");

/** @param {string[]} words */
const joinComma = (words) => words.join(", ");

/** @param {string} v */
const shortQuote = (v) => `'${v.slice(0, QUOTED_MAX)}'`;

/**
 * @param {string | null} text
 * @param {string[]} areas
 * @param {string} tree
 * @param {string[]} owed
 */
function markerFault(text, areas, tree, owed) {
	if (text === null) return "there is no marker";
	const tier = stripped(markerField(text, "tier"));
	if (tier === "") return "it has no tier= line";
	if (tier !== "escalated" && tier !== "mission-critical")
		return `its tier= is ${shortQuote(tier)}, and only escalated or mission-critical covers a declared sensitive path`;
	const named = new Set(markerList(text, "areas"));
	const missing = areas.filter((a) => !named.has(a));
	if (missing.length > 0)
		return `its areas= does not name ${joinComma(missing)}`;
	const recorded = stripped(markerField(text, "tree"));
	if (recorded === "") return "it has no tree= line";
	if (recorded !== tree)
		return "its tree= is not the tree this commit carries, so something changed after it was written";
	if (markerField(text, "paths") === null) return "it has no paths= line";
	const paths = markerList(text, "paths");
	if (paths.length === 0) return "its paths= names no path";
	const listed = new Set(paths);
	const unnamed = owed.filter((p) => !listed.has(p));
	if (unnamed.length > 0)
		return `its paths= does not name ${joinComma(unnamed.slice(0, NAMED_PATHS_MAX))}`;
	return "";
}

/**
 * @param {string} text
 * @param {string} tree
 */
const stampValue = (text, tree) =>
	`${stripped(markerField(text, "tier"))}; areas=${markerList(text, "areas").join(",")}; base=${stripped(markerField(text, "base"))}; tree=${tree}; paths=${markerList(text, "paths").join(",")}`;

/**
 * @param {object} r
 * @param {string[]} r.areas
 * @param {string[] | null} r.offSides
 * @param {string} r.marker
 * @param {string} r.fault
 * @param {string} r.stagedFault
 * @param {string} r.rule
 */
function refusal({ areas, offSides, marker, fault, stagedFault, rule }) {
	const lines = [
		"pre-commit: this commit changes a declared sensitive path, and no escalated review of exactly this change is recorded (#1622).",
		`  Areas touched: ${joinComma(areas)}.`,
	];
	if (offSides)
		lines.push(
			`  This merge's paths no merged-in side carries, the ones to review: ${joinComma(offSides)}.`,
		);
	lines.push(`  The marker ${marker} does not clear it: ${fault}.`);
	if (stagedFault)
		lines.push(
			`  The staged .claude/workflow-core.json will not read, and a review would land it broken, so correct it first: ${stagedFault}`,
		);
	lines.push(
		"",
		trimEndRun(rule, "\n"),
		"",
		"pre-commit: the review hold refused this commit (rule:review-hold). Nothing was committed.",
	);
	return `${lines.join("\n")}\n`;
}

module.exports = { markerFault, stampValue, refusal };
