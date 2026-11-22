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
 * @typedef {{
 *   comments: [number, number][],
 *   literals: Literal[],
 *   inert: [number, number][],
 * }} Scan
 * @typedef {{
 *   source: string,
 *   comments: [number, number][],
 *   literals: Literal[],
 *   inert: [number, number][],
 *   placeholders: number[],
 *   templateAt: number,
 *   regexOk: boolean,
 * }} State
 */

/** @param {string} source @param {number} i */
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

/** @param {string} source @param {number} i */
function quotedEnd(source, i) {
	const quote = source.charAt(i);
	let j = i + 1;
	while (j < source.length && !`${quote}\n`.includes(source.charAt(j)))
		j += source.charAt(j) === "\\" ? 2 : 1;
	return Math.min(j + 1, source.length);
}

/** @param {string} source @param {number} i */
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
	return wordEnd(source, Math.min(j + 1, source.length));
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

/** @param {State} st @param {number} j */
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
				st.inert.push([st.templateAt, j + 1]);
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

/** @param {State} st @param {number} i */
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

/** @param {State} st @param {number} start @param {number} end */
function pushInert(st, start, end) {
	if (st.templateAt < 0) st.inert.push([start, end]);
}

/** @param {State} st @param {number} i */
function step(st, i) {
	const { source } = st;
	const c = source.charAt(i);
	const comment = commentEnd(source, i);
	if (comment >= 0) {
		st.comments.push([i, comment]);
		pushInert(st, i, comment);
		return comment;
	}
	if (c === '"' || c === "'") {
		const end = quotedEnd(source, i);
		if (st.placeholders.length === 0 && st.templateAt < 0)
			st.literals.push({ at: i, raw: source.slice(i, end) });
		pushInert(st, i, end);
		st.regexOk = false;
		return end;
	}
	if (c === "`") {
		if (st.templateAt < 0) st.templateAt = i;
		return templateTextEnd(st, i + 1);
	}
	if (c === "/" && st.regexOk) {
		st.regexOk = false;
		const end = regexEnd(source, i);
		pushInert(st, i, end);
		return end;
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

/** @param {string} source @returns {Scan} */
function scanJs(source) {
	/** @type {State} */
	const st = {
		source,
		comments: [],
		literals: [],
		inert: [],
		placeholders: [],
		templateAt: -1,
		regexOk: true,
	};
	for (let i = 0; i < source.length; ) i = step(st, i);
	if (st.templateAt >= 0) st.inert.push([st.templateAt, source.length]);
	return { comments: st.comments, literals: st.literals, inert: st.inert };
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

/** @param {string} source @param {[number, number][]} ranges */
function blankRanges(source, ranges) {
	let out = "";
	let from = 0;
	for (const [start, end] of ranges) {
		out +=
			source.slice(from, start) +
			source.slice(start, end).replace(/[^\n]/g, " ");
		from = end;
	}
	return out + source.slice(from);
}

/** @param {string} source */
const blankComments = (source) => blankRanges(source, scanJs(source).comments);

/** @param {string} source */
const blankInert = (source) => blankRanges(source, scanJs(source).inert);

module.exports = { blankComments, blankInert, scanJs, stripComments };
