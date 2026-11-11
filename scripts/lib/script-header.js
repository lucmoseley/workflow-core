/*
 * script-header.js — a script's header, the opening comment block a checker
 * reads for markers, and the line-start pieces those markers' patterns open
 * with. Shared because check-code-standards.js reads `Unbuilt caller:` and
 * check-hand-callers.js reads `Caller:` off the same header (#4720, #4885).
 */

/** The opening comment block, shebang and blank lines included — a file's header. */
// eslint-disable-next-line regexp/no-super-linear-backtracking -- input is the host repo's own files, which its own writers control; a crafted one slows the check, nothing worse (#4642)
const HEADER = /^(?:#![^\n]*\n)?(?:\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*))*/;
/**
 * Blanks that stop at a line break, where `^` re-anchors anyway (#3383), and
 * a header line's start.
 */
const BLANKS = "[^\\S\\n\\r\\u2028\\u2029]*";
const LINE_START = `^${BLANKS}`;
const JS_COMMENT = String.raw`(?:\/\*+|\*|\/\/)`;
const HASH_COMMENTED = /\.(?:sh|bash|py)$/;
const HASH_HEADER = /^(?:[^\S\n]*(?:#[^\n]*)?\n)*/;
const PY_DOCSTRING = /^[^\S\n]*[rRuU]?("""|''')[\s\S]*?\1/;

/**
 * A script's header: its opening comment block, or for a `#`-commented
 * script its leading `#` lines and, in Python, the module docstring.
 *
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
