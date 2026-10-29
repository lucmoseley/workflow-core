/*
 * strip-comments.js — JavaScript source with its comments removed, for the lexical checks that
 * must not count a header's mention of `process.argv` or `ctx.has("--x")` as
 * a read; and the string and template literals it holds, for the readers of a
 * guard core's wording (lib/core-deny-text.js).
 *
 * A scan, not a pattern: a `/*` or `//` inside a literal opens no comment, a
 * quote inside a regex literal opens no string, and a template's `${…}` may
 * hold literals of its own. A `/` is read as a regex after an operator,
 * an opening bracket, a `}` or a keyword such as `return`, and as division
 * after a name, a number or a closing `)` or `]`. A regex replaced the scan
 * once a backtick inside a regex literal swallowed the rest of a file (#3001).
 */

const KEYWORDS_BEFORE_EXPRESSION = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"yield",
	"await",
]);

const WORD_START = /[A-Za-z_$]/;
const WORD = /[\w$]/;

/**
 * @typedef {{ at: number, raw: string }} Literal
 * @typedef {{ comments: [number, number][], literals: Literal[] }} Scan
 * @typedef {{
 *   source: string,
 *   comments: [number, number][],
 *   literals: Literal[],
 *   placeholders: number[],
 *   templateAt: number,
 *   regexOk: boolean,
 * }} State `placeholders` the brace depth inside each open `${…}`, innermost
 *   last; `templateAt` where the outermost open template began, or -1
 */

/**
 * Where the comment opening at `i` ends, or -1 where none opens there.
 * @param {string} source
 * @param {number} i
 */
function commentEnd(source, i) {
	if (source.charAt(i) !== "/") return -1;
	const next = source.charAt(i + 1);
	if (next === "/") {
		const end = source.indexOf("\n", i);
		return end < 0 ? source.length : end;
	}
	if (next !== "*") return -1;
	const end = source.indexOf("*/", i + 2);
	return end < 0 ? source.length : end + 2;
}

/**
 * Where the quoted string opening at `i` ends, its closing quote included; an
 * unclosed one ends at the line.
 * @param {string} source
 * @param {number} i
 */
function quotedEnd(source, i) {
	const quote = source.charAt(i);
	let j = i + 1;
	while (j < source.length && !`${quote}\n`.includes(source.charAt(j)))
		j += source.charAt(j) === "\\" ? 2 : 1;
	return j + 1;
}

/**
 * Where the regex literal opening at `i` ends, its flags included.
 * @param {string} source
 * @param {number} i
 */
function regexEnd(source, i) {
	let j = i + 1;
	let inClass = false;
	while (j < source.length && source.charAt(j) !== "\n") {
		const r = source.charAt(j);
		if (r === "/" && !inClass) break;
		if (r === "[") inClass = true;
		else if (r === "]") inClass = false;
		j += r === "\\" ? 2 : 1;
	}
	return wordEnd(source, j + 1);
}

/**
 * @param {string} source
 * @param {number} i
 */
function wordEnd(source, i) {
	let j = i;
	while (j < source.length && WORD.test(source.charAt(j))) j++;
	return j;
}

/**
 * Scan template text from `j` to its `${` or closing backtick, recording the
 * outermost template as it closes.
 * @param {State} st accumulator: the scan's literals, comments and position
 * @param {number} j
 */
function templateTextEnd(st, j) {
	const { source } = st;
	while (j < source.length) {
		const c = source.charAt(j);
		if (c === "\\") j += 2;
		else if (c === "`") {
			if (st.placeholders.length === 0) {
				st.literals.push({
					at: st.templateAt,
					raw: source.slice(st.templateAt, j + 1),
				});
				st.templateAt = -1;
			}
			st.regexOk = false;
			return j + 1;
		} else if (c === "$" && source.charAt(j + 1) === "{") {
			st.placeholders.push(0);
			st.regexOk = true;
			return j + 2;
		} else j++;
	}
	return j;
}

/**
 * A bracket or other punctuatorEnd at `i`: a `}` closing a placeholder resumes
 * its template.
 * @param {State} st accumulator: the scan's literals, comments and position
 * @param {number} i
 */
function punctuatorEnd(st, i) {
	const c = st.source.charAt(i);
	const depth = st.placeholders.at(-1);
	if (depth !== undefined && (c === "{" || c === "}")) {
		st.placeholders.pop();
		if (c === "}" && depth === 0) return templateTextEnd(st, i + 1);
		st.placeholders.push(c === "{" ? depth + 1 : depth - 1);
	}
	if (!/\s/.test(c)) st.regexOk = c !== ")" && c !== "]";
	return i + 1;
}

/**
 * Read the token at `i` into `st`, returning where the next one starts.
 * @param {State} st accumulator: the scan's literals, comments and position
 * @param {number} i
 */
function step(st, i) {
	const { source } = st;
	const c = source.charAt(i);
	const comment = commentEnd(source, i);
	if (comment >= 0) {
		st.comments.push([i, comment]);
		return comment;
	}
	if (c === '"' || c === "'") {
		const end = quotedEnd(source, i);
		if (st.placeholders.length === 0 && st.templateAt < 0)
			st.literals.push({ at: i, raw: source.slice(i, end) });
		st.regexOk = false;
		return end;
	}
	if (c === "`") {
		if (st.templateAt < 0) st.templateAt = i;
		return templateTextEnd(st, i + 1);
	}
	if (c === "/" && st.regexOk) {
		st.regexOk = false;
		return regexEnd(source, i);
	}
	if (WORD.test(c)) {
		const end = wordEnd(source, i);
		st.regexOk =
			WORD_START.test(c) &&
			KEYWORDS_BEFORE_EXPRESSION.has(source.slice(i, end));
		return end;
	}
	return punctuatorEnd(st, i);
}

/**
 * The comment spans and the outermost string and template literals of
 * `source`, in source order.
 * @param {string} source
 * @returns {Scan}
 */
function scanJs(source) {
	/** @type {State} */
	const st = {
		source,
		comments: [],
		literals: [],
		placeholders: [],
		templateAt: -1,
		regexOk: true,
	};
	for (let i = 0; i < source.length; ) i = step(st, i);
	return { comments: st.comments, literals: st.literals };
}

/** @param {string} source */
function stripComments(source) {
	let out = "";
	let from = 0;
	for (const [start, end] of scanJs(source).comments) {
		out += source.slice(from, start);
		from = end;
	}
	return out + source.slice(from);
}

/**
 * `source` with every comment blanked to spaces, its line breaks kept, so an
 * offset or line number in the result is the one in `source` (#3634).
 * @param {string} source
 */
function blankComments(source) {
	let out = "";
	let from = 0;
	for (const [start, end] of scanJs(source).comments) {
		out +=
			source.slice(from, start) +
			source.slice(start, end).replace(/[^\n]/g, " ");
		from = end;
	}
	return out + source.slice(from);
}

module.exports = { blankComments, scanJs, stripComments };
