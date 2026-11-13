/*
 * review-hold-marker.js — the review hold's judgement of its marker and the
 * text it answers with (#1622, spec #1612 §The hold): which fault a marker
 * carries, the `Review-Tier:` value a clearing one leaves, and the refusal.
 * lib/review-hold.js is its caller; it is a module of its own so the fault
 * ladder and the text are tested through these exports, word for word.
 */

const { stripNewlines } = require("./strip-newlines.js");

/**
 * concision-marker.sh's NAMED_PATHS_MAX, which the Stop nag lists paths up
 * to, so the hold and the nag name as many: a first guess there, never
 * measured. lib/review-hold-marker.test.ts pins the two together.
 */
const NAMED_PATHS_MAX = 10;

/**
 * The most of a bad tier= value a fault quotes: concision-marker.sh's
 * short_quote cuts at `%.40s`, so the hold and the nag quote alike.
 */
const QUOTED_MAX = 40;

/**
 * The value of the marker's first `<key>=` line, verbatim, or null where it
 * has none.
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
 * The comma-separated values of the marker's `<key>=` line, trimmed, empty
 * ones dropped.
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
 * Why the marker does not clear a commit holding `areas`, carrying `tree` and
 * owing review of `owed`, or "" where it does: an escalated tier naming every
 * area, `tree=` this tree, and `paths=` naming every owed path.
 * @param {string | null} text the marker, null where there is none
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
 * The `Review-Tier:` value a clearing marker leaves for the trailer.
 * @param {string} text
 * @param {string} tree
 */
const stampValue = (text, tree) =>
	`${stripped(markerField(text, "tier"))}; areas=${markerList(text, "areas").join(",")}; base=${stripped(markerField(text, "base"))}; tree=${tree}; paths=${markerList(text, "paths").join(",")}`;

/**
 * The refusal, every line of it.
 * @param {object} r
 * @param {string[]} r.areas
 * @param {string[] | null} r.offSides on a merge, the paths no side carries
 * @param {string} r.marker
 * @param {string} r.fault
 * @param {string} r.stagedFault the staged declaration's read fault, or ""
 * @param {string | null} r.rule the rule's text, null where unreadable
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
	if (rule === null)
		lines.push(
			"  The rule itself could not be read from docs/agents/rules/review-hold.txt. Restore that file from origin/main, or revert the change that removed it, then read it before going on.",
		);
	else lines.push("", stripNewlines(rule), "");
	lines.push(
		"pre-commit: the review hold refused this commit (rule:review-hold). Nothing was committed.",
	);
	return `${lines.join("\n")}\n`;
}

module.exports = { markerFault, stampValue, refusal };
