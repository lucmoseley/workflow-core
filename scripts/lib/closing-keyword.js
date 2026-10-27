/*
 * closing-keyword.js — the one copy of "does this commit message close an
 * issue?" (#138). Two callers:
 *
 *   lib/commit-form.js                  the PreToolUse deny, which sees
 *                                       `-m`/`--message` values and nothing
 *                                       else
 *   check-commit-message-closes.js      the git-hook scanner, which sees the
 *                                       finished message file whatever route
 *                                       wrote it
 *
 * ALL NINE OF GITHUB'S KEYWORDS: `close`, `closes`, `closed`, `fix`, `fixes`,
 * `fixed`, `resolve`, `resolves`, `resolved`, each followed by a reference, in
 * any case. An optional `:` between the keyword and the reference is the
 * trailer spelling of the same thing.
 *
 * ALL THREE SPELLINGS OF THE REFERENCE (mantahostels#2652): the bare `#12`,
 * the cross-repo `owner/repo#12`, and the full issue URL.
 */

const { readRuleTextOr } = require("./rule-text.js");

/* ASCII whitespace alone, POSIX [[:space:]]: \s would also take Unicode spaces. */
const SPACE = "[ \\t\\n\\v\\f\\r]";
const KEYWORD = `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)${SPACE}*:?${SPACE}*`;
const REPO = "(?:[a-z0-9._-]+/[a-z0-9._-]+)?";
const URL =
	"https?://github\\.com/[a-z0-9._-]+/[a-z0-9._-]+/issues/[0-9]+(?:[^0-9]|$)";
const CLOSING_RE = new RegExp(
	`(?:^|[^a-z])${KEYWORD}(?:${REPO}#[0-9]+|${URL})`,
	"i",
);

/**
 * The offending text as typed, for the refusal to quote back; null where
 * `text` closes nothing. The match loses the boundary characters it carries —
 * the separator in front, and for the URL arm the non-digit that ends it.
 * @param {string} text
 * @returns {string | null}
 */
function closingMatch(text) {
	const m = CLOSING_RE.exec(text);
	if (!m) return null;
	return m[0].replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
}

/**
 * What a refusal says after its own opening line: what matched, the rule, and
 * the way out.
 * @param {string} match closingMatch's
 * @param {string} [root] the host root, where a hook entry already resolved it
 *   (#3142)
 */
const closingRefusal = (match, root) =>
	`What matched: \`${match}\`\n\n${readRuleTextOr("commit-closes-keyword", "Never write a closing keyword before an issue reference in a commit message — write `Refs #n` instead", "closing-keyword", root)}\n\nRewrite the message with a non-closing reference and commit again.`;

module.exports = { closingMatch, closingRefusal };
