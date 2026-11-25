/** @typedef {import("./push-review.js").ReviewOwed} ReviewOwed */

const { coreRoot } = require("./script-path.js");
const { shellQuote } = require("./sh-quote.js");

const BASE = "0123456789abcdef0123456789abcdef01234567";
// workflow-core#5584
const MARKER_SCRIPT = shellQuote(
	`${coreRoot()}/scripts/write-review-marker.js`,
);

/** @type {Record<"none" | "standard" | "escalated" | "rejected" | "rejectedEscalated", ReviewOwed | null>} */
const ANSWERS = {
	none: null,
	standard: {
		tier: "standard",
		files: "scripts/mine.ts",
		base: BASE,
		tierLine: "The `standard` review tier is owed.",
		markerMore: "",
		passFault: "",
		markerScript: MARKER_SCRIPT,
	},
	escalated: {
		tier: "escalated",
		files: "supabase/migrations/001_rls.sql",
		base: BASE,
		tierLine:
			"The `escalated` review tier is owed: this change touches declared sensitive paths (RLS), which owe it at any size and in any file type (workflow-core#1618).",
		markerMore:
			" On this escalated change, record it with --tier escalated (or mission-critical) --areas 'RLS' as well, or it counts as no review.",
		passFault: "",
		markerScript: MARKER_SCRIPT,
	},
	rejected: {
		tier: "standard",
		files: "scripts/mine.ts",
		base: BASE,
		tierLine: "The `standard` review tier is owed.",
		markerMore: "",
		passFault: "its base= is not a 40-hex sha, 'main'",
		markerScript: MARKER_SCRIPT,
	},
	rejectedEscalated: {
		tier: "escalated",
		files: "supabase/migrations/001_rls.sql",
		base: BASE,
		tierLine:
			"The `escalated` review tier is owed: this change touches declared sensitive paths (RLS), which owe it at any size and in any file type (workflow-core#1618).",
		markerMore:
			" On this escalated change, record it with --tier escalated (or mission-critical) --areas 'RLS' as well, or it counts as no review.",
		passFault:
			"its tier= is 'standard', and only escalated or mission-critical covers a declared sensitive path",
		markerScript: MARKER_SCRIPT,
	},
};

/**
 * @param {keyof typeof ANSWERS} answer
 * @returns {(tree: string) => ReviewOwed | null}
 */
const fakeReviewOwed = (answer) => () => ANSWERS[answer];

module.exports = { ANSWERS, fakeReviewOwed };
