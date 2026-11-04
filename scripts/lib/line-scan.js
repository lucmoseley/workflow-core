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
 * The matches a `gm` regex `^([^#\n]*?)(?:^|<boundary>)<tail>` finds, in
 * order, each as its prefix (the text from the line start to the boundary)
 * and the value `tailAt` reads off the tail.
 *
 * A prefix may end at `prefixEnd` where, at a line start, the tail opens
 * there, or, before a `boundary` character, just past it. A tail opens only
 * on one of `heads`, so only the positions of those are read: in increasing
 * prefix end, the boundary just before each, then the head itself as a line
 * start. Each head's next position is kept, so no stretch is searched twice.
 * @param {string} text
 * @param {RegExp} boundary one character
 * @param {string[]} heads every tail `tailAt` reads opens with one of these
 * @param {(tailStart: number) => {end: number, value: string} | null} tailAt
 *   the tail's end and value where it opens at `tailStart`, else null
 * @returns {{prefix: string, value: string}[]}
 */
function lineHeadMatches(text, boundary, heads, tailAt) {
	const n = text.length;
	const nextAt = heads.map(() => -1);
	/** The first head at or after `from`, or -1. @param {number} from */
	const nextHead = (from) => {
		let best = -1;
		heads.forEach((head, k) => {
			if ((nextAt[k] ?? -1) < from && nextAt[k] !== n + 1)
				nextAt[k] = text.indexOf(head, from);
			if (nextAt[k] === -1) nextAt[k] = n + 1;
			const at = nextAt[k] ?? n + 1;
			if (at <= n && (best === -1 || at < best)) best = at;
		});
		return best;
	};
	/** @param {number} tailStart @param {number} from the line's start @param {number} stop */
	const hitAt = (tailStart, from, stop) => {
		const before = tailStart - 1;
		const afterBoundary =
			before >= from && before <= stop && boundary.test(text[before] ?? "");
		const opensLine = tailStart <= stop && atLineStart(text, tailStart);
		const found = afterBoundary || opensLine ? tailAt(tailStart) : null;
		if (!found) return null;
		return { prefixEnd: afterBoundary ? before : tailStart, found };
	};
	const out = [];
	let lineStart = 0;
	while (lineStart < n) {
		if (!atLineStart(text, lineStart)) {
			lineStart++;
			continue;
		}
		// The lazy prefix runs to the next `#` or `\n`, which may end it too.
		let stop = lineStart;
		while (stop < n && text[stop] !== "#" && text[stop] !== "\n") stop++;
		let hit = null;
		for (
			let tailStart = nextHead(lineStart);
			tailStart >= 0 && tailStart <= stop + 1 && !hit;
			tailStart = nextHead(tailStart + 1)
		)
			hit = hitAt(tailStart, lineStart, stop);
		if (!hit) {
			lineStart = stop + 1;
			continue;
		}
		out.push({
			prefix: text.slice(lineStart, hit.prefixEnd),
			value: hit.found.value,
		});
		lineStart = hit.found.end;
	}
	return out;
}

/** Whether `text` holds a `lib/<name>.sh` anywhere, as every match of
 * parseSourcedLibs does: most texts hold none.
 * Each `lib/` opens a name run the next `/` ends, so no run
 * is read twice. */
function hasLibPath(/** @type {string} */ text) {
	for (let at = text.indexOf(LIB); at >= 0; at = text.indexOf(LIB, at + 1)) {
		let end = at + LIB.length;
		while (end < text.length && /[\w.-]/.test(text[end] ?? "")) end++;
		const name = text.slice(at + LIB.length, end);
		if (name.lastIndexOf(SH) > 0) return true;
	}
	return false;
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
	if (!hasLibPath(text)) return [];
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
	return lineHeadMatches(text, /\s/, [SOURCE, "."], (tailStart) => {
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

/** Whether `afterNodeDollar` finds a `node` run anywhere in `text`, which
 * every match of the two parsers below opens with: most texts have none. */
function hasNodeDollar(/** @type {string} */ text) {
	for (let at = text.indexOf(NODE); at >= 0; at = text.indexOf(NODE, at + 1))
		if (afterNodeDollar(text, at) >= 0) return true;
	return false;
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
	if (!hasNodeDollar(text)) return [];
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
	return lineHeadMatches(text, /[\s(|;&]/, [NODE], (tailStart) => {
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
	if (!hasNodeDollar(text)) return [];
	return lineHeadMatches(text, /[\s(|;&]/, [NODE], (tailStart) => {
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
