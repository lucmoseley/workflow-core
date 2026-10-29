/*
 * js-lex.js — the bracket and argument scanning a lexical reader of JS or TS
 * source needs, with strings, comments and regex literals skipped so a
 * bracket or comma inside one is never counted (#1770). A guess, not a
 * parser: a `/` is read as opening a regex only after a character no value
 * ends with, so a division after `)` or a name is left alone; and a quoted
 * string closes at its line, so an apostrophe in JSX text hides at most the
 * rest of that line (#3659).
 */

/**
 * How far back the regex-or-division guess looks for the last character
 * before a `/`, past any whitespace. A guess — 40 covers an indented line
 * break.
 */
const REGEX_LOOKBACK = 40;

/** @param {string} text @param {number} i  a quote @returns {number} */
function quoteEnd(text, i) {
	const close = text[i] === "`" ? "`" : `${text[i]}\n`;
	let j = i + 1;
	while (j < text.length && !close.includes(text[j]))
		j += text[j] === "\\" ? 2 : 1;
	return j;
}

/** @param {string} text @param {number} i  a `//` or `/*` @returns {number} */
function commentEnd(text, i) {
	if (text[i + 1] === "/") {
		const nl = text.indexOf("\n", i);
		return nl === -1 ? text.length : nl;
	}
	const end = text.indexOf("*/", i + 2);
	return end === -1 ? text.length : end + 1;
}

/**
 * A regex literal's closing `/`, or `i` where the `/` at `i` opens none.
 * @param {string} text
 * @param {number} i
 * @returns {number}
 */
function regexEnd(text, i) {
	const before = text.slice(Math.max(0, i - REGEX_LOOKBACK), i);
	if (!/(?:^|[(,=:[!&|?{};>]|\*\/)\s*$/.test(before)) return i;
	let inClass = false;
	for (let j = i + 1; j < text.length; j++) {
		const d = text[j];
		if (d === "\\") j++;
		else if (d === "\n") return i;
		else if (d === "[" || d === "]") inClass = d === "[";
		else if (d === "/" && !inClass) return j;
	}
	return i;
}

/**
 * Where a string, comment or regex literal opening at `i` ends — its last
 * character — or `i` itself where none opens there.
 * @param {string} text
 * @param {number} i
 * @returns {number}
 */
function tokenEnd(text, i) {
	const c = text.charAt(i);
	if ("\"'`".includes(c)) return quoteEnd(text, i);
	if (c !== "/") return i;
	const next = text[i + 1];
	return next === "/" || next === "*" ? commentEnd(text, i) : regexEnd(text, i);
}

/**
 * The index just past the bracket closing the one at `open`, or -1, with
 * strings, comments and regex literals skipped.
 * @param {string} text
 * @param {number} open  index of a `(`, `[` or `{`
 * @returns {number}
 */
function closeOf(text, open) {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const c = text.charAt(i);
		if (c === "\\") i++;
		else if (tokenEnd(text, i) !== i) i = tokenEnd(text, i);
		else if ("([{".includes(c)) depth++;
		else if (")]}".includes(c) && --depth === 0) return i + 1;
	}
	return -1;
}

/**
 * A call's or list's arguments, split at its own top-level commas.
 * @param {string} inner  the text between the brackets
 * @returns {string[]}
 */
function topLevelArgs(inner) {
	const out = [];
	let at = 0;
	for (let i = 0; i < inner.length; i++) {
		const c = inner.charAt(i);
		if ("([{".includes(c)) {
			const end = closeOf(inner, i);
			if (end === -1) break;
			i = end - 1;
		} else if (tokenEnd(inner, i) !== i) i = tokenEnd(inner, i);
		else if (c === ",") {
			out.push(inner.slice(at, i).trim());
			at = i + 1;
		}
	}
	const last = inner.slice(at).trim();
	if (last) out.push(last);
	return out;
}

/**
 * Where the statement starting at `from` ends: just past its first `;`
 * outside any bracket, string, comment or regex literal, or the end of the
 * text. Biome ends every statement with one, so a line break never does.
 * @param {string} text
 * @param {number} from
 * @returns {number}
 */
function statementEnd(text, from) {
	for (let i = from; i < text.length; i++) {
		const c = text.charAt(i);
		if ("([{".includes(c)) {
			const end = closeOf(text, i);
			if (end === -1) return text.length;
			i = end - 1;
		} else if (tokenEnd(text, i) !== i) i = tokenEnd(text, i);
		else if (c === ";") return i + 1;
	}
	return text.length;
}

/**
 * Where each string, comment and regex literal in `text` sits, as `[first,
 * last]` index pairs in order: the stretches that are not code. A template
 * literal is one stretch, its interpolations included.
 * @param {string} text
 * @returns {[number, number][]}
 */
function inertSpans(text) {
	/** @type {[number, number][]} */
	const out = [];
	for (let i = 0; i < text.length; i++) {
		if (text.charAt(i) === "\\") {
			i++;
			continue;
		}
		const end = tokenEnd(text, i);
		if (end === i) continue;
		out.push([i, end]);
		i = end;
	}
	return out;
}

module.exports = {
	closeOf,
	inertSpans,
	statementEnd,
	topLevelArgs,
};
