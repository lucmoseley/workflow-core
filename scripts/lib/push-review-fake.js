/*
 * push-review-fake.js — the one fake of lib/push-review.js's port (workflow-core#2785),
 * for push-rules.js's module cases.
 */

/** @typedef {import("./push-review.js").ReviewOwed} ReviewOwed */

const BASE = "0123456789abcdef0123456789abcdef01234567";

/** @type {Record<"none" | "standard" | "escalated" | "rejected" | "rejectedEscalated", ReviewOwed | null>} */
const ANSWERS = {
	/* No code of the session's past the floor, or a marker that covers it. */
	none: null,
	/* Code past the floor, no marker. */
	standard: {
		tier: "standard",
		files: "scripts/mine.ts",
		base: BASE,
		tierLine: "The `standard` review tier is owed.",
		markerMore: "",
		passFault: "",
		markerScript: "scripts/write-review-marker.js",
	},
	/* A declared sensitive path, no marker. */
	escalated: {
		tier: "escalated",
		files: "supabase/migrations/001_rls.sql",
		base: BASE,
		tierLine:
			"The `escalated` review tier is owed: this change touches declared sensitive paths (RLS), which owe it at any size and in any file type (workflow-core#1618).",
		markerMore:
			" On this escalated change, record it with --tier escalated (or mission-critical) --areas 'RLS' as well, or it counts as no review.",
		passFault: "",
		markerScript: "scripts/write-review-marker.js",
	},
	/* Code past the floor, and a marker the validator rejects. */
	rejected: {
		tier: "standard",
		files: "scripts/mine.ts",
		base: BASE,
		tierLine: "The `standard` review tier is owed.",
		markerMore: "",
		passFault: "its base= is not a 40-hex sha, 'main'",
		markerScript: "scripts/write-review-marker.js",
	},
	/* A declared sensitive path, and a marker at too low a tier for it. */
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
		markerScript: "scripts/write-review-marker.js",
	},
};

/**
 * @param {keyof typeof ANSWERS} answer
 * @returns {(tree: string) => ReviewOwed | null}
 */
const fakeReviewOwed = (answer) => () => ANSWERS[answer];

module.exports = { ANSWERS, fakeReviewOwed };
