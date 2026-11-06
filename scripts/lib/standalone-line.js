/*
 * standalone-line.js — whether an issue body records why it has no parent, as
 * the `Standalone:` line `file-issue.js --standalone` writes (#1027), and that
 * line. Shared so the line the filers write and the line the orphan check
 * accepts cannot drift apart (#1615).
 *
 * Residual: a line inside a quote or code fence counts.
 */

/* Leading blanks stop at a line break, where `^` re-anchors anyway (#3383). */
/** @param {string | null | undefined} body */
const hasStandaloneLine = (body) =>
	/^[^\S\n\r\u2028\u2029]*Standalone:/m.test(body || "");

/** @param {string} why */
const buildStandaloneLine = (why) => `Standalone: ${why}`;

module.exports = { buildStandaloneLine, hasStandaloneLine };
