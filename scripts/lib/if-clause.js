/*
 * if-clause.js — a hook registration's `if` clause, `Tool(glob)` in the
 * harness's permission-rule syntax: read, and matched against a call
 * (mantahostels#3287, #3224). A core: no I/O.
 *
 * clausesAdmit tests the glob against the whole command and each of its
 * segments, so it admits every call the harness's own `if` would
 * (docs/agents/guard-authoring.md: the harness splits `&&`, `;` and `|` and
 * reaches into `$()` and backticks) and some it would not.
 */

const { requiredGroup } = require("./regex-group.js");

/**
 * A permission-rule glob as an anchored RegExp.
 *
 * `[\s\S]*` rather than `.*`: a Bash command is routinely multi-line, and `.`
 * stops at a newline, so `Bash(*npm *)` would miss `npm test` on line two.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
	const body = String(glob)
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("[\\s\\S]*");
	return new RegExp(`^${body}$`);
}

// One tool name, deliberately: both readers compare the name literally, so
// an alternation here would match no tool at all.
const IF_CLAUSE_RE = /^([A-Za-z]\w*)\(([\s\S]*)\)$/;

/**
 * A settings.json `if` clause split into the tool it names and its glob.
 * `null` where it is not of the `Tool(pattern)` shape this file can read.
 *
 * @param {unknown} clause
 * @returns {{tool: string, glob: string} | null}
 */
function parseIfClause(clause) {
	if (typeof clause !== "string") return null;
	const m = IF_CLAUSE_RE.exec(clause.trim());
	if (!m) return null;
	return {
		tool: requiredGroup(m, 1, IF_CLAUSE_RE),
		glob: requiredGroup(m, 2, IF_CLAUSE_RE),
	};
}

/** Where a command splits into segments: every list and pipe operator, a
 * newline, and the opening of a subshell or substitution. A split, not
 * lib/shell-parse.js's parse: it runs on every Bash call, and splitting
 * where no operator stands only admits more. */
const SEGMENT_RE = /&&|\|\||[;|&\n(`]|\$\(/;

/** What may stand before a segment's command: a compound command's keyword,
 * `!`, a brace group, `time`, and `NAME=value` assignments. */
const PREFIX_RE =
	/^(?:\s*(?:(?:if|then|elif|else|do|while|until|time|!|\{)(?=\s)|[A-Za-z_]\w*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|\\.|[^\s"'\\])*(?=\s)))*\s*/;

/**
 * Whether `clauses` let a `tool` call whose judged text is `subject` through:
 * true where no clause names `tool`, else where some clause naming it matches
 * the subject whole or one of its segments, read from its command word.
 * @param {string[]} clauses each `Tool(glob)`; an unreadable one matches
 *   every call
 * @param {string | undefined} tool
 * @param {string} subject
 */
function clausesAdmit(clauses, tool, subject) {
	const own = clauses.flatMap((c) => {
		const parsed = parseIfClause(c);
		if (!parsed) return [/^/];
		return parsed.tool === tool ? [globToRegExp(parsed.glob)] : [];
	});
	if (own.length === 0) return true;
	const texts = [
		subject,
		...subject.split(SEGMENT_RE).map((s) => s.replace(PREFIX_RE, "")),
	];
	return own.some((re) => texts.some((t) => re.test(t)));
}

module.exports = { clausesAdmit, globToRegExp, parseIfClause };
