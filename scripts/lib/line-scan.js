const RUNNERS = ["node", "bash", "sh"];
const PROGRAM_SUFFIXES = [".js", ".sh"];

const atLineStart = (/** @type {string} */ text, /** @type {number} */ i) =>
	i === 0 || "\n\r  ".includes(text[i - 1] ?? "");

function blankEnd(/** @type {string} */ text, /** @type {number} */ from) {
	let end = from;
	while (end < text.length && /\s/.test(text[end] ?? "")) end++;
	return end;
}

/**
 * @param {string} text
 * @param {RegExp} cls
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
 * @param {string} text
 * @param {(i: number) => number} endAt
 */
function nextOnLine(text, endAt) {
	const out = new Int32Array(text.length + 1).fill(-1);
	for (let i = text.length - 1; i >= 0; i--)
		if (text[i] !== "\n") out[i] = endAt(i) >= 0 ? i : (out[i + 1] ?? -1);
	return out;
}

/**
 * @param {string} text
 * @param {RegExp} boundary
 * @param {string[]} heads
 * @template {{end: number}} T
 * @param {(tailStart: number) => T | null} tailAt
 * @returns {({prefix: string} & Omit<T, "end">)[]}
 */
function lineHeadMatches(text, boundary, heads, tailAt) {
	const n = text.length;
	const nextAt = heads.map(() => -1);
	/** @param {number} from */
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
	/** @param {number} tailStart @param {number} from @param {number} stop */
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
		const { end, ...fields } = hit.found;
		out.push({ prefix: text.slice(lineStart, hit.prefixEnd), ...fields });
		lineStart = end;
	}
	return out;
}

function afterRunDollar(/** @type {string} */ text, /** @type {number} */ at) {
	const runner = RUNNERS.find((r) => text.startsWith(r, at));
	if (!runner) return -1;
	const keywordEnd = at + runner.length;
	let argStart = blankEnd(text, keywordEnd);
	if (argStart === keywordEnd) return -1;
	if (text[argStart] === '"') argStart++;
	return text[argStart] === "$" ? argStart + 1 : -1;
}

function hasRunDollar(/** @type {string} */ text) {
	return RUNNERS.some((runner) => {
		for (
			let at = text.indexOf(runner);
			at >= 0;
			at = text.indexOf(runner, at + 1)
		)
			if (afterRunDollar(text, at) >= 0) return true;
		return false;
	});
}

/**
 * @param {string} text
 * @returns {{prefix: string, lead: string, value: string}[]}
 */
function parseProgramRuns(text) {
	if (!hasRunDollar(text)) return [];
	const marks = PROGRAM_SUFFIXES.map((suffix) => ({
		suffix,
		at: lastMarkInRun(text, /[\w./-]/, suffix),
	}));
	/** @param {number} slash */
	const tailEnd = (slash) => {
		const nameStart = slash + "/".length;
		if (text[slash] !== "/" || !/[\w-]/.test(text[nameStart] ?? "")) return -1;
		const ends = marks
			.map(({ suffix, at }) => {
				const last = at[nameStart + 1] ?? -1;
				return last < 0 ? -1 : last + suffix.length;
			})
			.filter((end) => end >= 0);
		return ends.length > 0 ? Math.max(...ends) : -1;
	};
	const nextTail = nextOnLine(text, tailEnd);
	return lineHeadMatches(text, /[\s(|;&]/, RUNNERS, (tailStart) => {
		const pathFrom = afterRunDollar(text, tailStart);
		const slash = pathFrom < 0 ? -1 : (nextTail[pathFrom] ?? -1);
		if (slash < 0) return null;
		const end = tailEnd(slash);
		return {
			end,
			lead: text.slice(pathFrom, slash),
			value: text.slice(slash + "/".length, end),
		};
	});
}

/**
 * @param {string} text
 * @returns {{prefix: string, value: string}[]}
 */
function parseProgramVars(text) {
	if (!hasRunDollar(text)) return [];
	return lineHeadMatches(text, /[\s(|;&]/, RUNNERS, (tailStart) => {
		let nameStart = afterRunDollar(text, tailStart);
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
 * @param {string} text
 * @param {RegExp} head
 * @param {RegExp} tail
 * @param {string} stops
 * @returns {{index: number, head: RegExpExecArray, tail: RegExpExecArray}[]}
 */
function segmentTailMatches(text, head, tail, stops) {
	const out = [];
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
	PROGRAM_SUFFIXES,
	parseProgramRuns,
	parseProgramVars,
	segmentTailMatches,
};
