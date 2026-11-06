/*
 * ticketed-tags.js — whether a whole-spec review comment names, on each line
 * marking a finding TICKETED, the exception that let it skip fix-first (#4492,
 * #4284). resolve-ticket.js, the guard-issue-close core and the
 * guard-review-comment core read a comment through this one reader, so the
 * three routes a review comment takes cannot disagree.
 *
 * A review comment is one carrying `**Reviewed through:**`. A TICKETED line is
 * one holding the upper-case word and the issue it went to; it passes where it
 * also holds one of the three tags
 * `docs/agents/rules/review-finding-destination.txt` names.
 * Fenced blocks, quoted lines and spans quoting either head are masked as
 * lib/review-findings.js masks a record's mentions.
 *
 * Residual: it reads the tag, never whether the exception is true; a finding
 * whose tag sits on a continuation line is refused.
 */

const { maskMentions } = require("./review-findings.js");
const { scriptPath } = require("./script-path.js");

const REVIEWED_THROUGH = /\*\*Reviewed through:\*\*/;
const TICKETED = /(?<![A-Za-z])TICKETED(?![A-Za-z])/;
/* A finding ticketed here: the word then the issue it went to, as in
 * `TICKETED #4491`, `TICKETED on #4491` or `TICKETED in owner/repo#7`, and
 * not one an earlier pass ticketed (#4492's review). */
const TICKETING =
	/(?<!(?:previously|already|earlier|was|were)\s+)(?<![A-Za-z])TICKETED[\s,:]*(?:(?:on|in|as|under|to)\s+)?(?:[\w.-]+\/[\w.-]+)?#\d/;
const HEADS = new RegExp(`${REVIEWED_THROUGH.source}|${TICKETED.source}`);
const TAG =
	/\bclaimed by\s+\S|\bneeds its own design:\s*\S|\bexposed, not caused\b/i;

/* The fragment `docs/agents/rules/review-finding-destination.txt` spells
 * these tags too, so the refusal and the rule cannot drift:
 * review-rules.test.ts pins the fragment to this copy (§G11). */
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
	const masked = maskMentions(comment, HEADS).split("\n");
	if (!masked.some((line) => REVIEWED_THROUGH.test(line))) return [];
	const raw = comment.split("\n");
	return masked.flatMap((line, i) => {
		if (!TICKETING.test(line)) return [];
		const text = raw[i];
		if (text === undefined)
			throw new Error(
				`ticketed-tags: the mask changed the line count at line ${i + 1}`,
			);
		return TAG.test(text) ? [] : [text.trim()];
	});
}

/**
 * What to tell a session posting `comment`: each TICKETED line naming no
 * exception and the three tags, below the caller's own headline; null where
 * every such line names one, or the comment is no whole-spec review.
 *
 * @param {string} comment
 * @returns {string | null}
 */
function ticketedRefusal(comment) {
	const lines = untaggedTicketed(comment);
	if (lines.length === 0) return null;
	return [
		...lines.map((line) => `  ${line}`),
		`Fix ${lines.length === 1 ? "it" : "each"} here (FIXED <sha>), or add to the line the exception that let it skip fix-first: ${TAGS} (#4492, #4284). Rule: \`${scriptPath("lib/rule-text.sh")} review-finding-destination\`.`,
	].join("\n");
}

module.exports = { TAGS, ticketedRefusal };
