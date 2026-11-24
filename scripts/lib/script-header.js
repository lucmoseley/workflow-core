const HEADER =
	/^(?:#![^\n]*\n)?(?:\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*(?=\n|$)))*/;
const BLANKS = "[^\\S\\n\\r\\u2028\\u2029]*";
const LINE_START = `^${BLANKS}`;
const JS_COMMENT = String.raw`(?:\/\*+|\*|\/\/)`;
const HASH_COMMENTED = /\.(?:sh|bash|py)$/;
const HASH_HEADER = /^(?:[^\S\n]*(?:#[^\n]*)?\n)*/;
const PY_DOCSTRING = /^[^\S\n]*[rRuU]?("""|''')[\s\S]*?\1/;

/**
 * @param {string} rel
 * @param {string} text
 */
function headerOf(rel, text) {
	if (!HASH_COMMENTED.test(rel)) return HEADER.exec(text)?.[0] ?? "";
	const hashLength = HASH_HEADER.exec(text)?.[0].length ?? 0;
	const docstring = rel.endsWith(".py")
		? (PY_DOCSTRING.exec(text.slice(hashLength))?.[0] ?? "")
		: "";
	return text.slice(0, hashLength + docstring.length);
}

module.exports = { BLANKS, JS_COMMENT, LINE_START, headerOf };
