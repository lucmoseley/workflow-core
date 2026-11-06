/*
 * ticketed-tags.js — whether a whole-spec review comment names, on each line
 * marking a finding TICKETED, the exception that let it skip fix-first (#4492,
 * #4284). resolve-ticket.js, the guard-issue-close core and the
 * guard-review-comment core read a comment through this one reader, so the
 * three routes a review comment takes cannot disagree.
 *
 * A review comment is one carrying `**Reviewed through:**`. A TICKETED line is
 * any line holding the upper-case word; it passes where it also holds one of
 * the three tags `docs/agents/rules/review-finding-destination.txt` names.
 * Fenced blocks, quoted lines and spans quoting either head are masked as
 * lib/review-findings.js masks a record's mentions.
 *
 * Residual: it reads the tag, never whether the exception is true; a finding
 * whose tag sits on a continuation line is refused.
 */

const { scriptPath } = require("./script-path.js");

const REVIEWED_THROUGH = /\*\*Reviewed through:\*\*/;
const TICKETED = /(?<![A-Za-z])TICKETED(?![A-Za-z])/;
const HEADS = new RegExp(`${REVIEWED_THROUGH.source}|${TICKETED.source}`);
const TAG =
	/\bclaimed by\s+\S|\bneeds its own design:\s*\S|\bexposed, not caused\b/i;

const TAGS =
	"`claimed by <session name>`, `needs its own design: <reason>` or `exposed, not caused`";

/**
 * The TICKETED lines of a review comment that name no exception, trimmed; []
 * where the comment is no review comment.
 *
 * @param {string} comment
 * @returns {string[]}
 */
function untaggedTicketed(comment) {
	if (!REVIEWED_THROUGH.test(comment)) return [];
	const { maskMentions } = require("./review-findings.js");
	const masked = maskMentions(comment, HEADS).split("\n");
	if (!masked.some((line) => REVIEWED_THROUGH.test(line))) return [];
	const raw = comment.split("\n");
	return masked.flatMap((line, i) =>
		TICKETED.test(line) && !TAG.test(raw[i] ?? "")
			? [(raw[i] ?? "").trim()]
			: [],
	);
}

/**
 * The refusal for `lines`, naming each and the three tags.
 *
 * @param {string[]} lines what untaggedTicketed returned, non-empty
 */
const buildTicketedRefusal = (lines) =>
	[
		`This whole-spec review comment tickets ${lines.length === 1 ? "a finding" : `${lines.length} findings`} without naming the exception that let it skip fix-first:`,
		...lines.map((line) => `  ${line}`),
		`Fix it here (FIXED <sha>), or add to that line the exception that applies: ${TAGS} (#4492, #4284). Rule: \`${scriptPath("lib/rule-text.sh")} review-finding-destination\`.`,
	].join("\n");

module.exports = { buildTicketedRefusal, untaggedTicketed };
