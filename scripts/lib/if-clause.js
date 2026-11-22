const { escapeRe, requiredGroup } = require("./regex-group.js");

/**
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
	const body = String(glob).split("*").map(escapeRe).join("[\\s\\S]*");
	return new RegExp(`^${body}$`);
}

const IF_CLAUSE_RE = /^([A-Za-z]\w*)\(([\s\S]*)\)$/;

/**
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

const SEGMENT_RE = /&&|\|\||[;|&\n(`]|\$\(/;

const PREFIX_RE =
	/^(?:\s*(?:(?:if|then|elif|else|do|while|until|time|!|\{)(?=\s)|[A-Za-z_]\w*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|\\.|[^\s"'\\])*(?=\s)))*\s*/;

/**
 * @param {string[]} clauses
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
