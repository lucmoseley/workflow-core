const { readRuleTextOr } = require("./rule-text.js");

const SPACE = "[ \\t\\n\\v\\f\\r]";
const KEYWORD = `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)${SPACE}*(?::${SPACE}*)?`;
const REPO = "(?:[a-z0-9._-]+/[a-z0-9._-]+)?";
const URL =
	"https?://github\\.com/[a-z0-9._-]+/[a-z0-9._-]+/issues/[0-9]+(?:[^0-9]|$)";
const CLOSING_RE = new RegExp(
	`(?:^|[^a-z])${KEYWORD}(?:${REPO}#[0-9]+|${URL})`,
	"i",
);

/**
 * @param {string} text
 * @returns {string | null}
 */
function closingMatch(text) {
	const m = CLOSING_RE.exec(text);
	if (!m) return null;
	return m[0]
		.replace(/^[^A-Za-z0-9]+/, "")
		.replace(/(?<![^A-Za-z0-9])[^A-Za-z0-9]+$/, "");
}

/**
 * @param {string} match
 * @param {string} [root]
 */
const closingRefusal = (match, root) =>
	`What matched: \`${match}\`\n\n${readRuleTextOr("commit-closes-keyword", "Never write a closing keyword before an issue reference in a commit message — write `Refs #n` instead", "closing-keyword", root)}\n\nRewrite the message with a non-closing reference and commit again.`;

module.exports = { closingMatch, closingRefusal };
