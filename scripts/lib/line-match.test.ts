/*
 * line-match.test.ts — pins lib/line-match.js's matcher (#4903) against the
 * textbook LCS table on seeded random lists. A short
 * match makes lib/landed-edit.js see a kept line as dropped, which can read
 * an unlanded change as landed and so offer `git worktree remove --force`
 * over it.
 */

import { describe, expect, it } from "vitest";
import { matchLines } from "./line-match.js";

/** A longest common subsequence's length. */
function lcsLength(a: string[], b: string[]) {
	let row = new Array<number>(b.length + 1).fill(0);
	for (const x of a) {
		const next = [0];
		for (let j = 0; j < b.length; j++)
			next.push(
				x === b[j]
					? (row[j] ?? 0) + 1
					: Math.max(row[j + 1] ?? 0, next[j] ?? 0),
			);
		row = next;
	}
	return row[b.length] ?? 0;
}

/** A seeded generator, so a failure replays: the ANSI C `rand` LCG's
 * constants, which reach every value mod 2^31. */
function seeded(seed: number) {
	let s = seed;
	return () => {
		s = (Math.imul(s, 1_103_515_245) + 12_345) & 0x7f_ff_ff_ff;
		return s / 2 ** 31;
	};
}

/* Guesses, not measured: enough lists, each shorter than LENGTH_LIMIT so
 * the table stays small, drawn from the first one to all of ALPHABET's
 * lines so repeats, the hard case, are common. */
const TRIALS = 3000;
const LENGTH_LIMIT = 12;
const ALPHABET = "abcd";

describe("matchLines (#4903)", () => {
	it("matches a longest common subsequence, in order, line for line", () => {
		const rand = seeded(4903);
		for (let t = 0; t < TRIALS; t++) {
			const alphabet = ALPHABET.slice(0, 1 + (t % ALPHABET.length));
			const list = () =>
				Array.from(
					{ length: Math.floor(rand() * LENGTH_LIMIT) },
					() => alphabet[Math.floor(rand() * alphabet.length)] ?? "a",
				);
			const a = list();
			const b = list();
			const at = [...matchLines(a, b)];
			const hits = at.flatMap((j, i) => (j === -1 ? [] : [[i, j] as const]));
			for (const [i, j] of hits) expect(a[i]).toBe(b[j]);
			const ys = hits.map(([, j]) => j);
			expect(ys).toEqual([...ys].sort((x, y) => x - y));
			expect(new Set(ys).size).toBe(ys.length);
			expect(hits.length).toBe(lcsLength(a, b));
		}
	});

	it("matches every line of identical lists and none of disjoint ones", () => {
		expect([...matchLines(["x", "y"], ["x", "y"])]).toEqual([0, 1]);
		expect([...matchLines(["x", "y"], ["p", "q"])]).toEqual([-1, -1]);
		expect([...matchLines([], ["p"])]).toEqual([]);
	});
});
