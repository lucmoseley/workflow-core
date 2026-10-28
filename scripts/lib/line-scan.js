/*
 * line-scan.js — matches made of a head and the rest of its line, found in
 * linear time. A regex that opens a lazy prefix at each line start, or retries
 * a line tail from every head on that line, reads the line once per attempt:
 * quadratic on a line of heads that reach nothing (#3383). Each function here
 * reads each position a fixed number of times.
 *
 * Two engines: lineHeadMatches for a lazy line prefix ending at a keyword,
 * and segmentTailMatches for a head followed by a scan to the segment's end.
 * The three parsers are the shell-guard spellings check-guard-registry.js
 * follows to a guard's dependencies.
 */

const SOURCE = "source";
const NODE = "node";
const LIB = "lib/";
const SH = ".sh";
const JS = ".js";

/** Where `^` matches under the `m` flag: the start, or after a line break. */
const atLineStart = (/** @type {string} */ text, /** @type {number} */ i) =>
	i === 0 || "\n\r  ".includes(text[i - 1] ?? "");

/** The end of the whitespace run at `from`. */
function blankEnd(/** @type {string} */ text, /** @type {number} */ from) {
	let end = from;
	while (end < text.length && /\s/.test(text[end] ?? "")) end++;
	return end;
}

/**
 * An array with one entry per position of `text`, plus one for its end: at a
 * position inside a run of `cls` characters, the start of the last `mark`
 * that begins at or after it within that run; -1 everywhere else.
 * @param {string} text
 * @param {RegExp} cls one character
 * @param {string} mark
 */
function lastMarkInRun(text, cls, mark) {
	const out = new Int32Array(text.length + 1).fill(-1);
	for (let i = text.length - 1; i >= 0; i--) {
		if (!cls.test(text[i] ?? "")) continue;
		const later = out[i + 1] ?? -1;
		if (later >= 0) out[i] = later;
		else if (text.startsWith(mark, i)) out[i] = i;
	}
	return out;
}

/**
 * An array with one entry per position of `text`, plus one for its end: the
 * first position at or after it, before the next `\n`, where `endAt` finds a
 * match; -1 where there is none.
 * @param {string} text
 * @param {(i: number) => number} endAt the match's end at `i`, or -1
 */
function nextOnLine(text, endAt) {
	const out = new Int32Array(text.length + 1).fill(-1);
	for (let i = text.length - 1; i >= 0; i--)
		if (text[i] !== "\n") out[i] = endAt(i) >= 0 ? i : (out[i + 1] ?? -1);
	return out;
}

/**
 * Where a line prefix may end in a match. `hit[prefixEnd]` is the tail read
 * when a prefix ends at `prefixEnd`: at a line start the tail opens there,
 * and before a `boundary` character it opens just past that character; null
 * where neither gives one. `nextHit[i]` is the first `prefixEnd` at or after
 * `i` whose hit is not null, or -1.
 * @param {string} text
 * @param {RegExp} boundary
 * @param {(tailStart: number) => {end: number, value: string} | null} tailAt
 */
function headHits(text, boundary, tailAt) {
	const n = text.length;
	/** @type {({end: number, value: string} | null)[]} */
	const hit = new Array(n + 1).fill(null);
	const nextHit = new Int32Array(n + 2).fill(-1);
	for (let prefixEnd = n; prefixEnd >= 0; prefixEnd--) {
		let found = atLineStart(text, prefixEnd) ? tailAt(prefixEnd) : null;
		if (!found && prefixEnd < n && boundary.test(text[prefixEnd] ?? ""))
			found = tailAt(prefixEnd + 1);
		hit[prefixEnd] = found;
		nextHit[prefixEnd] = found ? prefixEnd : (nextHit[prefixEnd + 1] ?? -1);
	}
	return { hit, nextHit };
}

/**
 * The matches a `gm` regex `^([^#\n]*?)(?:^|<boundary>)<tail>` finds, in
 * order, each as its prefix (the text from the line start to the boundary)
 * and the value `tailAt` reads off the tail.
 * @param {string} text
 * @param {RegExp} boundary one character
 * @param {(tailStart: number) => {end: number, value: string} | null} tailAt
 *   the tail's end and value where it opens at `tailStart`, else null
 * @returns {{prefix: string, value: string}[]}
 */
function lineHeadMatches(text, boundary, tailAt) {
	const n = text.length;
	const { hit, nextHit } = headHits(text, boundary, tailAt);
	// Where each lazy prefix must stop: the next `#` or `\n`.
	const stop = new Int32Array(n + 1).fill(n);
	for (let i = n - 1; i >= 0; i--)
		stop[i] = text[i] === "#" || text[i] === "\n" ? i : (stop[i + 1] ?? n);
	const out = [];
	for (let lineStart = 0; lineStart < n; lineStart++) {
		if (!atLineStart(text, lineStart)) continue;
		const prefixEnd = nextHit[lineStart] ?? -1;
		const found = hit[prefixEnd];
		if (prefixEnd < 0 || prefixEnd > (stop[lineStart] ?? n) || !found) continue;
		out.push({ prefix: text.slice(lineStart, prefixEnd), value: found.value });
		lineStart = found.end - 1;
	}
	return out;
}

/**
 * The libs a shell text sources: on each line, before any `#`, a `source` or
 * `.` that opens the line or follows a blank, then a blank, then the first
 * `lib/<name>.sh` later on that line, where `<name>` is the longest run of
 * `[\w.-]` characters ending in `.sh`. The same paths as
 * `/^[^#\n]*?(?:^|\s)(?:source|\.)\s+[^\n]*?(lib\/[\w.-]+\.sh)/gm`'s group 1.
 * @param {string} text
 * @returns {string[]} each `lib/….sh` path, in order
 */
function parseSourcedLibs(text) {
	const sh = lastMarkInRun(text, /[\w.-]/, SH);
	/** @param {number} libStart */
	const libEnd = (libStart) => {
		const nameStart = libStart + LIB.length;
		const lastSh = sh[nameStart + 1] ?? -1;
		return text.startsWith(LIB, libStart) &&
			/[\w.-]/.test(text[nameStart] ?? "") &&
			lastSh >= 0
			? lastSh + SH.length
			: -1;
	};
	const nextLib = nextOnLine(text, libEnd);
	/** @param {number} at */
	const keywordEnd = (at) => {
		if (text.startsWith(SOURCE, at)) return at + SOURCE.length;
		return text[at] === "." ? at + 1 : -1;
	};
	return lineHeadMatches(text, /\s/, (tailStart) => {
		const end = keywordEnd(tailStart);
		if (end < 0) return null;
		const argStart = blankEnd(text, end);
		const libStart = argStart > end ? (nextLib[argStart] ?? -1) : -1;
		if (libStart < 0) return null;
		const pathEnd = libEnd(libStart);
		return { end: pathEnd, value: text.slice(libStart, pathEnd) };
	}).map((m) => m.value);
}

/** Past the `node\s+"?\$` at `at`, or -1 where it is not there. */
function afterNodeDollar(/** @type {string} */ text, /** @type {number} */ at) {
	if (!text.startsWith(NODE, at)) return -1;
	const keywordEnd = at + NODE.length;
	let argStart = blankEnd(text, keywordEnd);
	if (argStart === keywordEnd) return -1;
	if (text[argStart] === '"') argStart++;
	return text[argStart] === "$" ? argStart + 1 : -1;
}

/**
 * The programs a shell text runs self-relatively: on each line, before any
 * `#`, a `node` that opens the line or follows one of `\s(|;&`, then blanks,
 * an optional `"` and a `$`, then the first `/<tail>.js` later on that line,
 * where `<tail>` opens with `[\w-]` and is the longest run of `[\w./-]`
 * characters ending in `.js`. The same matches as
 * `/^([^#\n]*?)(?:^|[\s(|;&])node\s+"?\$[^\n]*?\/([\w-][\w./-]*\.js)/gm`,
 * the prefix its group 1 and the value its group 2.
 * @param {string} text
 * @returns {{prefix: string, value: string}[]} each line's text before
 *   `node`, and the path after the `/`
 */
function parseNodeRuns(text) {
	const js = lastMarkInRun(text, /[\w./-]/, JS);
	/** @param {number} slash */
	const tailEnd = (slash) => {
		const nameStart = slash + "/".length;
		const lastJs = js[nameStart + 1] ?? -1;
		return text[slash] === "/" &&
			/[\w-]/.test(text[nameStart] ?? "") &&
			lastJs >= 0
			? lastJs + JS.length
			: -1;
	};
	const nextTail = nextOnLine(text, tailEnd);
	return lineHeadMatches(text, /[\s(|;&]/, (tailStart) => {
		const pathFrom = afterNodeDollar(text, tailStart);
		const slash = pathFrom < 0 ? -1 : (nextTail[pathFrom] ?? -1);
		if (slash < 0) return null;
		const end = tailEnd(slash);
		return { end, value: text.slice(slash + "/".length, end) };
	});
}

/**
 * The variables a shell text runs as a program: on each line, before any
 * `#`, a `node` placed as parseNodeRuns' is, then blanks, an optional `"`, a
 * `$` and a name of `\w` characters, braced or not, followed by the text's
 * end or one of `"\s;|)`. The same matches as
 * `/^([^#\n]*?)(?:^|[\s(|;&])node\s+"?\$\{?(\w+)\}?(?=["\s;|)]|$)/gm`, the
 * prefix its group 1 and the value its group 2.
 * @param {string} text
 * @returns {{prefix: string, value: string}[]} each line's text before
 *   `node`, and the variable's name
 */
function parseNodeVars(text) {
	return lineHeadMatches(text, /[\s(|;&]/, (tailStart) => {
		let nameStart = afterNodeDollar(text, tailStart);
		if (nameStart < 0) return null;
		if (text[nameStart] === "{") nameStart++;
		let nameEnd = nameStart;
		while (nameEnd < text.length && /\w/.test(text[nameEnd] ?? "")) nameEnd++;
		const end = text[nameEnd] === "}" ? nameEnd + 1 : nameEnd;
		const closed = end === text.length || /["\s;|)]/.test(text[end] ?? "");
		return nameEnd > nameStart && closed
			? { end, value: text.slice(nameStart, nameEnd) }
			: null;
	});
}

/**
 * The matches of `head` each followed by `tail`, in the order a `g` regex
 * of the two in sequence finds them. `tail` must be sticky and open with
 * `[^<stops>]*`, and what follows that run must never start at a stop
 * character: then a tail that fails at one position fails at every later
 * position up to the next stop, and that stretch is never read again. As
 * one regex, every head on a line is a fresh start that rescans the line to
 * its end, quadratic on a line of heads that reach no tail.
 *
 * The head must decide its own extent, as one whose every part is greedy
 * and cannot give characters back to a match would: the tail is tried only
 * where the head's first reading ends.
 * @param {string} text
 * @param {RegExp} head global
 * @param {RegExp} tail sticky
 * @param {string} stops the characters `tail`'s opening run excludes
 * @returns {{index: number, head: RegExpExecArray, tail: RegExpExecArray}[]}
 *   each match's start, and the head's and the tail's own matches
 */
function segmentTailMatches(text, head, tail, stops) {
	const out = [];
	// The stretch, from a failed tail start to the next stop, known to fail.
	let dead = { from: -1, to: -1 };
	head.lastIndex = 0;
	for (let h = head.exec(text); h; h = head.exec(text)) {
		const tailStart = h.index + h[0].length;
		const known = tailStart >= dead.from && tailStart <= dead.to;
		tail.lastIndex = tailStart;
		const t = known ? null : tail.exec(text);
		if (t) {
			out.push({ index: h.index, head: h, tail: t });
			head.lastIndex = t.index + t[0].length;
			continue;
		}
		if (!known)
			dead = { from: tailStart, to: nextStop(text, tailStart, stops) };
		head.lastIndex = h.index + 1;
	}
	return out;
}

/** The first position at or after `from` holding one of `stops`, else the end. */
function nextStop(
	/** @type {string} */ text,
	/** @type {number} */ from,
	/** @type {string} */ stops,
) {
	let at = from;
	while (at < text.length && !stops.includes(text.charAt(at))) at++;
	return at;
}

module.exports = {
	parseSourcedLibs,
	parseNodeRuns,
	parseNodeVars,
	segmentTailMatches,
};
