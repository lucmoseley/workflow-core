const { scanJs } = require("./strip-comments.js");

// measured 79 scans for one file at peak, workflow-core#3667
const SCANS_KEPT = 256;

/** @typedef {{ spans: [number, number][], lasts: Map<number, number> }} Inert */

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
 * @param {string} text
 * @param {number} i
 */
function isInsideInert(text, i) {
	const { spans } = inertOf(text);
	let lo = 0;
	let hi = spans.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const span = spans[mid];
		if (span === undefined) throw new Error(`no inert span at ${mid}`);
		if (span[0] < i) lo = mid + 1;
		else hi = mid;
	}
	const before = spans[lo - 1];
	return before !== undefined && before[1] >= i;
}

/**
 * @param {string} text
 * @param {number} i
 * @returns {number}
 */
function tokenEnd(text, i) {
	return inertOf(text).lasts.get(i) ?? i;
}

/**
 * @param {string} text
 * @param {number} open
 * @returns {number}
 */
function closeOf(text, open) {
	if (isInsideInert(text, open)) {
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
 * @param {string} inner
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
 * @param {string} text
 * @param {number} from
 * @returns {number}
 */
function statementEnd(text, from) {
	if (isInsideInert(text, from))
		return from + statementEnd(text.slice(from), 0);
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
