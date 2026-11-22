const { maskMentions } = require("./review-findings.js");
const { scriptPath } = require("./script-path.js");

const REVIEWED_THROUGH = /\*\*Reviewed through:\*\*/;
const TICKETED = /(?<![A-Za-z])TICKETED(?![A-Za-z])/;
const WORD = "TICKETED";
const EARLIER = ["previously", "already", "earlier"];
const SEPARATOR = /[\s,:;*_`(\u2014\u2013\u2192>-]/;
const LINK_WORD = sticky(/(?:on|in|as|under|to)\s+/y);
const OWNER_CHAR = /[\w.-]/;
const REPO_TAIL = sticky(/\/[\w.-]+#\d/y);
const URL_HEAD = sticky(/https?:\/\//y);
const ISSUE_PATH = sticky(/\/issues\/\d/y);

const LETTER = /[A-Za-z]/;

/** @param {RegExp} re */
function sticky(re) {
	return (/** @type {string} */ text, /** @type {number} */ at) => {
		re.lastIndex = at;
		return re.test(text) ? re.lastIndex : -1;
	};
}

/** @param {string} line */
function buildTargetTables(line) {
	const owner = new Uint8Array(line.length + 1);
	const issue = new Int32Array(line.length + 1).fill(-1);
	let laterOwner = 0;
	let laterIssue = -1;
	for (let i = line.length - 1; i >= 0; i--) {
		const c = line.charAt(i);
		if (!OWNER_CHAR.test(c)) laterOwner = 0;
		else if (!OWNER_CHAR.test(line.charAt(i + 1)))
			laterOwner = Number(REPO_TAIL(line, i + 1) !== -1);
		owner[i] = laterOwner;
		if (/\s/.test(c)) laterIssue = -1;
		else if (laterIssue === -1 && ISSUE_PATH(line, i) !== -1) laterIssue = i;
		issue[i] = laterIssue;
	}
	return { owner, issue };
}

/** @param {string} line */
function hasTicketing(line) {
	/** @type {ReturnType<typeof buildTargetTables> | undefined} */
	let tables;
	for (
		let at = line.indexOf(WORD);
		at !== -1;
		at = line.indexOf(WORD, at + 1)
	) {
		if (LETTER.test(line.charAt(at - 1)) || isTicketedEarlier(line, at))
			continue;
		let end = at + WORD.length;
		while (end < line.length && SEPARATOR.test(line.charAt(end))) end++;
		tables ??= buildTargetTables(line);
		const linked = LINK_WORD(line, end);
		if (
			isIssueAt(line, end, tables) ||
			(linked !== -1 && isIssueAt(line, linked, tables)) ||
			(/[_-]/.test(line.charAt(end - 1)) && REPO_TAIL(line, end) !== -1)
		)
			return true;
	}
	return false;
}

function isTicketedEarlier(
	/** @type {string} */ line,
	/** @type {number} */ at,
) {
	let word = at;
	while (word > 0 && /\s/.test(line.charAt(word - 1))) word--;
	return EARLIER.some((w) => line.endsWith(w, word));
}

/**
 * @param {string} line
 * @param {number} at
 * @param {ReturnType<typeof buildTargetTables>} tables
 */
function isIssueAt(line, at, { owner, issue }) {
	if (line.charAt(at) === "#" && /\d/.test(line.charAt(at + 1))) return true;
	if (owner[at]) return true;
	const path = URL_HEAD(line, at);
	if (path === -1) return false;
	const last = issue[path];
	if (last === undefined)
		throw new Error(`ticketed-tags: no issue-table entry at ${path}`);
	return last > path;
}

const HEADS = new RegExp(`${REVIEWED_THROUGH.source}|${TICKETED.source}`);
const TAG =
	/\bclaimed by\s+\S|\bneeds its own design:\s*\S|\bexposed, not caused\b/i;

const TAGS =
	"`claimed by <session name>`, `needs its own design: <reason>` or `exposed, not caused`";

/** @param {string} comment @returns {string[]} */
function untaggedTicketed(comment) {
	if (!REVIEWED_THROUGH.test(comment)) return [];
	const masked = maskMentions(comment, HEADS).split("\n");
	if (!masked.some((line) => REVIEWED_THROUGH.test(line))) return [];
	const raw = comment.split("\n");
	return masked.flatMap((line, i) => {
		if (!hasTicketing(line)) return [];
		const text = raw[i];
		if (text === undefined)
			throw new Error(
				`ticketed-tags: the mask changed the line count at line ${i + 1}`,
			);
		return TAG.test(text) ? [] : [text.trim()];
	});
}

/** @param {string} comment @returns {string | null} */
function ticketedRefusal(comment) {
	const lines = untaggedTicketed(comment);
	if (lines.length === 0) return null;
	return [
		...lines.map((line) => `  ${line}`),
		`Fix ${lines.length === 1 ? "it" : "each"} here (FIXED <sha>), or add to the line the exception that let it skip fix-first: ${TAGS}. Rule: \`${scriptPath("lib/rule-text.sh")} review-finding-destination\`.`,
	].join("\n");
}

module.exports = { ticketedRefusal };
