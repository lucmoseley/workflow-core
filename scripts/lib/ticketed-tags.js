/*
 * ticketed-tags.js — whether a whole-spec review comment names, on each line
 * marking a finding TICKETED, the exception that let it skip fix-first (#4492,
 * #4284).
 *
 * A review comment is one carrying `**Reviewed through:**`. A TICKETED line is
 * one holding the upper-case word and the issue it went to; it passes where it
 * also holds one of the three tags
 * `docs/agents/rules/review-finding-destination.txt` names.
 * Fenced blocks, quoted lines and spans quoting either head are masked as
 * lib/review-findings.js masks a record's mentions.
 *
 * Residual: it reads the tag, never whether the exception is true; a finding
 * whose tag sits on a continuation line is refused; a backticked `TICKETED`
 * reads as a mention and passes.
 */

const { maskMentions } = require("./review-findings.js");
const { scriptPath } = require("./script-path.js");

const REVIEWED_THROUGH = /\*\*Reviewed through:\*\*/;
const TICKETED = /(?<![A-Za-z])TICKETED(?![A-Za-z])/;
/* A finding ticketed here: the word then the issue it went to, as in
 * `TICKETED #4491`, `**TICKETED** (#4491)`, `TICKETED on #4491`,
 * `TICKETED → owner/repo#7` or an issue URL, and not one an earlier pass
 * ticketed. Read by index, each character a fixed number of times: as one
 * regex, a line of `TICKETED-` repeated read the line once per word (#4647). */
const WORD = "TICKETED";
const EARLIER = ["previously", "already", "earlier"];
const SEPARATOR = /[\s,:;*_`(\u2014\u2013\u2192>-]/;
const LINK_WORD = /(?:on|in|as|under|to)\s+/y;
const OWNER_CHAR = /[\w.-]/;
/* What ends an `owner/repo#<n>` past the owner, from its `/`. */
const REPO_TAIL = /\/[\w.-]+#\d/y;
const URL_HEAD = /https?:\/\//y;
const ISSUE_PATH = /\/issues\/\d/y;

const LETTER = /[A-Za-z]/;

/** Whether sticky `re` matches `text` at `at`; its end, where it does. */
function stickyEnd(
	/** @type {RegExp} */ re,
	/** @type {string} */ text,
	/** @type {number} */ at,
) {
	re.lastIndex = at;
	return re.test(text) ? re.lastIndex : -1;
}

/**
 * Per position of `line`, plus its end: `owner`, whether an `owner/repo#<n>`
 * starts there; `issue`, the last `/issues/<digit>` starting at or after it
 * before the next whitespace, -1 for none.
 * @param {string} line
 */
function targetTables(line) {
	const owner = new Uint8Array(line.length + 1);
	const issue = new Int32Array(line.length + 1).fill(-1);
	for (let i = line.length - 1; i >= 0; i--) {
		const c = line.charAt(i);
		if (OWNER_CHAR.test(c))
			owner[i] = OWNER_CHAR.test(line.charAt(i + 1))
				? (owner[i + 1] ?? 0)
				: Number(stickyEnd(REPO_TAIL, line, i + 1) !== -1);
		if (/\S/.test(c)) {
			const later = issue[i + 1] ?? -1;
			issue[i] =
				later !== -1 || stickyEnd(ISSUE_PATH, line, i) === -1 ? later : i;
		}
	}
	return { owner, issue };
}

/**
 * Whether `line` marks a finding ticketed: the word, no letter before it and
 * no `previously`, `already` or `earlier` and whitespace; a run of separators;
 * an optional `on`, `in`, `as`, `under` or `to`; then `#<n>`, `owner/repo#<n>`
 * or an issue URL. An owner may open in the separators' trailing `_` or `-`.
 * @param {string} line
 */
function namesTicketing(line) {
	/** @type {ReturnType<typeof targetTables> | undefined} */
	let tables;
	for (
		let at = line.indexOf(WORD);
		at !== -1;
		at = line.indexOf(WORD, at + 1)
	) {
		if (LETTER.test(line.charAt(at - 1)) || ticketedEarlier(line, at)) continue;
		let end = at + WORD.length;
		while (end < line.length && SEPARATOR.test(line.charAt(end))) end++;
		tables ??= targetTables(line);
		const linked = stickyEnd(LINK_WORD, line, end);
		if (
			issueAt(line, end, tables) ||
			(linked !== -1 && issueAt(line, linked, tables)) ||
			(/[_-]/.test(line.charAt(end - 1)) &&
				stickyEnd(REPO_TAIL, line, end) !== -1)
		)
			return true;
	}
	return false;
}

/* Whether `previously`, `already` or `earlier` and any whitespace end at `at`:
 * with none, the letter before `at` already refuses it. */
function ticketedEarlier(/** @type {string} */ line, /** @type {number} */ at) {
	let word = at;
	while (word > 0 && /\s/.test(line.charAt(word - 1))) word--;
	return EARLIER.some((w) => line.endsWith(w, word));
}

/**
 * Whether `#<n>`, `owner/repo#<n>` or an issue URL starts at `at`.
 * @param {string} line
 * @param {number} at
 * @param {ReturnType<typeof targetTables>} tables
 */
function issueAt(line, at, { owner, issue }) {
	if (line.charAt(at) === "#" && /\d/.test(line.charAt(at + 1))) return true;
	if (owner[at]) return true;
	const path = stickyEnd(URL_HEAD, line, at);
	return path !== -1 && (issue[path] ?? -1) > path;
}

const HEADS = new RegExp(`${REVIEWED_THROUGH.source}|${TICKETED.source}`);
const TAG =
	/\bclaimed by\s+\S|\bneeds its own design:\s*\S|\bexposed, not caused\b/i;

/* The fragment `docs/agents/rules/review-finding-destination.txt` spells
 * these tags too: review-rules.test.ts pins the fragment to the refusal's
 * copy (§G11). */
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
		if (!namesTicketing(line)) return [];
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
		`Fix ${lines.length === 1 ? "it" : "each"} here (FIXED <sha>), or add to the line the exception that let it skip fix-first: ${TAGS}. Rule: \`${scriptPath("lib/rule-text.sh")} review-finding-destination\`.`,
	].join("\n");
}

module.exports = { ticketedRefusal };
