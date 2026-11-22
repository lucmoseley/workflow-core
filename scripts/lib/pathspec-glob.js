const { escapeRe, requiredGroup } = require("./regex-group.js");

/** @param {string} p */
const normalise = (p) => p.replace(/\/{2,}/g, "/").replace(/^(\.\/)+/, "");

const POSIX_CLASS = /^\[:([a-z]+):\]/;

const POSIX_CLASSES = /** @type {Record<string, string>} */ ({
	alnum: "a-zA-Z0-9",
	alpha: "a-zA-Z",
	blank: " \\t",
	cntrl: "\\x00-\\x1f\\x7f",
	digit: "0-9",
	graph: "\\x21-\\x7e",
	lower: "a-z",
	print: "\\x20-\\x7e",
	punct: "!-\\/:-@\\[-`{-~",
	space: " \\t\\n\\r\\f\\v",
	upper: "A-Z",
	xdigit: "0-9a-fA-F",
});

/**
 * @param {string} glob
 * @param {number} i
 * @returns {[string, number] | null}
 */
function parseBracket(glob, i) {
	let j = i + 1;
	const negate = glob[j] === "!" || glob[j] === "^";
	if (negate) j++;
	let body = "";
	for (let first = true; j < glob.length; first = false) {
		if (glob[j] === "]" && !first) {
			const cls = `[${negate ? "^/" : ""}${body}]`;
			return [negate ? cls : `(?!/)${cls}`, j + 1];
		}
		const [member, width] = parseBracketMember(glob, j);
		body += member;
		j += width;
	}
	return null;
}

/**
 * @param {string} glob
 * @param {number} j
 * @returns {[string, number]}
 */
function parseBracketMember(glob, j) {
	const c = glob.charAt(j);
	const posix = POSIX_CLASS.exec(glob.slice(j));
	const members = posix
		? POSIX_CLASSES[requiredGroup(posix, 1, POSIX_CLASS)]
		: undefined;
	if (posix && members !== undefined) return [members, posix[0].length];
	if (c === "\\" && j + 1 < glob.length) return [`\\${glob.charAt(j + 1)}`, 2];
	return ["\\]^".includes(c) ? `\\${c}` : c, 1];
}

/**
 * @param {string} glob
 * @returns {RegExp}
 */
function buildWildcardRegExp(glob) {
	let re = "";
	for (let i = 0; i < glob.length; ) {
		const [piece, next] = parseWildcardToken(glob, i);
		re += piece;
		i = next;
	}
	return new RegExp(`^${re}$`);
}

/**
 * @param {string} glob
 * @param {number} i
 * @returns {[string, number]}
 */
function parseWildcardToken(glob, i) {
	const c = glob.charAt(i);
	if (c === "*" && glob[i + 1] === "*") return parseStarRun(glob, i);
	if (c === "*") return ["[^/]*", i + 1];
	if (c === "?") return ["[^/]", i + 1];
	if (c === "[") return parseBracket(glob, i) ?? ["\\[", i + 1];
	if (c === "\\" && i + 1 < glob.length)
		return [escapeRe(glob.charAt(i + 1)), i + 2];
	return [escapeRe(c), i + 1];
}

/**
 * @param {string} glob
 * @param {number} i
 * @returns {[string, number]}
 */
function parseStarRun(glob, i) {
	let end = i;
	while (glob[end] === "*") end++;
	const atStart = i === 0 || glob[i - 1] === "/";
	const slashAfter = /^\\?\//.exec(glob.slice(end));
	if (atStart && end === glob.length) return [".*", end];
	if (atStart && slashAfter) return ["(?:.*/)?", end + slashAfter[0].length];
	return ["[^/]*", end];
}

/**
 * @param {string} glob
 * @param {string} path
 */
function globMatches(glob, path) {
	const g = normalise(glob);
	const p = normalise(path);
	const dir = g.replace(/\/$/, "");
	if ((g === dir && p === dir) || p.startsWith(`${dir}/`)) return true;
	return /[*?[\\]/.test(g) && buildWildcardRegExp(g).test(p);
}

module.exports = { globMatches };
