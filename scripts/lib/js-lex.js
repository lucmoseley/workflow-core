/*
 * js-lex.js — the bracket and argument scanning a lexical reader of JS or TS
 * source needs, with strings, comments and regex literals skipped so a
 * bracket or comma inside one is never counted (#1770). What is a literal or
 * a comment is strip-comments.js's scanJs to decide, so a reader that blanks
 * comments with it and finds brackets here never sees the two disagree
 * (#3667).
 */

const { scanJs } = require("./strip-comments.js");

/**
 * How many texts' span ends are kept before the cache is emptied whole. A
 * reader scans one source and the slices it cuts from it: the most one file
 * sent through generate-test-read-edges.js was 79 (check-guard-registry.js,
 * measured at #3667), so emptying costs at most one rescan of the source.
 */
const SCANS_KEPT = 256;

/**
 * @typedef {{ spans: [number, number][], lasts: Map<number, number> }} Inert
 *   `spans` each stretch that is not code as `[first, last]`, in order;
 *   `lasts` the same, keyed by its first index
 */

/** @type {Map<string, Inert>} */
const inertByText = new Map();

/**
 * @param {string} text
 * @returns {Inert}
 */
function inertOf(text) {
	let inert = inertByText.get(text);
	if (!inert) {
		if (inertByText.size >= SCANS_KEPT) inertByText.clear();
		/** @type {[number, number][]} */
		const spans = scanJs(text).inert.map(([start, end]) => [start, end - 1]);
		inert = { spans, lasts: new Map(spans) };
		inertByText.set(text, inert);
	}
	return inert;
}

/**
 * Whether `i` falls inside a stretch that is not code, past its first index.
 * A scan started there reads the text from `i` as code, as a reader handing
 * an index inside a template's text means it (#3667).
 * @param {string} text
 * @param {number} i
 */
function insideInert(text, i) {
	const { spans } = inertOf(text);
	let lo = 0;
	let hi = spans.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (spans[mid][0] < i) lo = mid + 1;
		else hi = mid;
	}
	return lo > 0 && spans[lo - 1][1] >= i;
}

/**
 * Where a string, comment or regex literal opening at `i` ends — its last
 * character — or `i` itself where none opens there.
 * @param {string} text
 * @param {number} i
 * @returns {number}
 */
function tokenEnd(text, i) {
	return inertOf(text).lasts.get(i) ?? i;
}

/**
 * The index just past the bracket closing the one at `open`, or -1, with
 * strings, comments and regex literals skipped.
 * @param {string} text
 * @param {number} open  index of a `(`, `[` or `{`
 * @returns {number}
 */
function closeOf(text, open) {
	if (insideInert(text, open)) {
		const end = closeOf(text.slice(open), 0);
		return end === -1 ? -1 : open + end;
	}
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const c = text.charAt(i);
		if (tokenEnd(text, i) !== i) i = tokenEnd(text, i);
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
	if (insideInert(text, from)) return from + statementEnd(text.slice(from), 0);
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
	return inertOf(text).spans;
}

module.exports = {
	closeOf,
	inertSpans,
	statementEnd,
	topLevelArgs,
};
