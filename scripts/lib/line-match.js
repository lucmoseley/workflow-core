/*
 * line-match.js — a longest common subsequence of two line lists, by Myers'
 * linear-space O(ND) diff, for lib/landed-edit.js (#4903). Linear space,
 * since a landed version can sit thousands of edits from the base.
 */

/**
 * For each line of `a`, the index of the line of `b` it matches in one
 * longest common subsequence, or -1 where it has none.
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 * @returns {Int32Array}
 */
function matchLines(a, b) {
	/** @type {Map<string, number>} */
	const ids = new Map();
	const intern = (/** @type {readonly string[]} */ lines) =>
		Int32Array.from(lines, (line) => {
			const id = ids.get(line) ?? ids.size;
			ids.set(line, id);
			return id;
		});
	const size = 2 * (a.length + b.length) + 3;
	/** @type {Graph} */
	const g = {
		xs: intern(a),
		ys: intern(b),
		fwd: new Int32Array(size),
		back: new Int32Array(size),
	};
	const at = new Int32Array(a.length).fill(-1);
	/** @type {Box[]} */
	const stack = [{ x0: 0, x1: a.length, y0: 0, y1: b.length }];
	for (let box = stack.pop(); box; box = stack.pop()) {
		let { x0, x1, y0, y1 } = box;
		while (x0 < x1 && y0 < y1 && g.xs[x0] === g.ys[y0]) at[x0++] = y0++;
		while (x0 < x1 && y0 < y1 && g.xs[x1 - 1] === g.ys[y1 - 1]) at[--x1] = --y1;
		if (x0 === x1 || y0 === y1) continue;
		const [sx, sy, ex] = middleSnake(g, { x0, x1, y0, y1 });
		for (let i = 0; i < ex - sx; i++) at[sx + i] = sy + i;
		stack.push(
			{ x0, x1: sx, y0, y1: sy },
			{ x0: ex, x1, y0: sy + (ex - sx), y1 },
		);
	}
	return at;
}

/**
 * @typedef {{xs: Int32Array, ys: Int32Array, fwd: Int32Array, back: Int32Array}} Graph
 *   the two lists as line ids, and each direction's furthest x per diagonal
 * @typedef {{x0: number, x1: number, y0: number, y1: number}} Box
 *   the edit graph of `xs[x0..x1)` against `ys[y0..y1)`
 */

/**
 * The middle snake of `box`, as its start `[x, y]` and end x, in whole-list
 * coordinates (Myers 1986, §4b). Both ranges are non-empty and differ at
 * each end.
 * @param {Graph} g
 * @param {Box} box
 * @returns {[number, number, number]}
 */
function middleSnake(g, { x0, x1, y0, y1 }) {
	const n = x1 - x0;
	const m = y1 - y0;
	const delta = n - m;
	const odd = (delta & 1) === 1;
	const off = n + m + 1;
	g.fwd[off + 1] = 0;
	g.back[off + 1] = 0;
	const ahead = (/** @type {number} */ x, /** @type {number} */ y) =>
		g.xs[x0 + x] === g.ys[y0 + y];
	const behind = (/** @type {number} */ x, /** @type {number} */ y) =>
		g.xs[x1 - 1 - x] === g.ys[y1 - 1 - y];
	const span = { n, m, delta, off };
	for (let d = 0; d <= Math.ceil((n + m) / 2); d++) {
		const f = sweep(span, d, odd ? d - 1 : -1, {
			v: g.fwd,
			other: g.back,
			same: ahead,
		});
		if (f) return [x0 + f.start, y0 + f.start - f.k, x0 + f.end];
		const b = sweep(span, d, odd ? -1 : d, {
			v: g.back,
			other: g.fwd,
			same: behind,
		});
		if (b) return [x1 - b.end, y1 - (b.end - b.k), x1 - b.start];
	}
	throw new Error("line-match: no middle snake");
}

/**
 * One direction's d-path sweep, from its own corner: where a path ends on a
 * diagonal within `reach` of the other direction's and the two overlap, the
 * snake it ended on.
 * @param {{n: number, m: number, delta: number, off: number}} span
 * @param {number} d
 * @param {number} reach -1 where this direction tests no overlap at `d`
 * @param {{v: Int32Array, other: Int32Array, same: (x: number, y: number) => boolean}} dir
 * @returns {{k: number, start: number, end: number}|null}
 */
function sweep({ n, m, delta, off }, d, reach, { v, other, same }) {
	for (let k = -d; k <= d; k += 2) {
		const left = /** @type {number} */ (v[off + k - 1]);
		const right = /** @type {number} */ (v[off + k + 1]);
		let x = k === -d || (k !== d && left < right) ? right : left + 1;
		const start = x;
		while (x < n && x - k < m && same(x, x - k)) x++;
		v[off + k] = x;
		const c = delta - k;
		if (Math.abs(c) <= reach && x + /** @type {number} */ (other[off + c]) >= n)
			return { k, start, end: x };
	}
	return null;
}

module.exports = { matchLines };
