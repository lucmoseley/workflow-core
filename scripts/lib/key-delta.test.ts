// @vitest-environment node
/*
 * Pins spec #1510's delta gate where it lives (#1725): a key set, never a
 * count (mantahostels#2483), and the outcome tests both repo-checks readers
 * sort a job by.
 *
 * Loosen one and the daily notify line drops a key that was gained, or
 * reprints a whole backlog nobody drains.
 */

import { describe, expect, it } from "vitest";

const {
	isCompleted,
	isJudged,
	isUnexamined,
	judgeKeys,
} = require("./key-delta.js");

/** `delivered: null` is nothing delivered yet, so a completed outcome's every key reads as gained. */
const judge = (keys: string[], delivered: string[] | null, outcome = "FAIL") =>
	judgeKeys(
		{ outcome, keys },
		{ countedKeys: keys, delivered: delivered && new Set(delivered), tag: 1 },
	);

describe("the delta gate", () => {
	it("gains nothing on an unchanged set, and stamps it", () => {
		const r = judge(["k1", "k2"], ["k1", "k2"]);
		expect(r.added).toEqual([]);
		expect(r.stamp).toBe(JSON.stringify(["k1", "k2"]));
	});

	it("gains every key where none were delivered", () => {
		expect(judge(["k1", "k2"], null).added).toEqual(["k1", "k2"]);
	});

	it("gains the new members when the count is unchanged (mantahostels#2483)", () => {
		expect(judge(["a", "d", "e"], ["a", "b", "c"]).added).toEqual(["d", "e"]);
	});

	it("gains nothing when keys are only removed", () => {
		expect(judge(["a"], ["a", "b"]).added).toEqual([]);
	});

	it("gains a key that disappeared and came back", () => {
		const cleared = judge([], ["a"]);
		expect(cleared.added).toEqual([]);
		const back = judgeKeys(
			{ outcome: "FAIL", keys: ["a"] },
			{
				countedKeys: ["a"],
				delivered: new Set(JSON.parse(cleared.stamp)),
				tag: 1,
			},
		);
		expect(back.added).toEqual(["a"]);
	});

	it("counts a gain in `countedKeys` alone, while the stamp holds every key", () => {
		const r = judgeKeys(
			{ outcome: "FAIL", keys: ["SETTLED\t#1", "OPEN\t#2"] },
			{ countedKeys: ["OPEN\t#2"], delivered: null, tag: 1 },
		);
		expect(r.added).toEqual(["OPEN\t#2"]);
		expect(JSON.parse(r.stamp)).toEqual(["OPEN\t#2", "SETTLED\t#1"]);
	});

	it("reads an unexamined job as no gain at all, under a stamp carrying what was delivered", () => {
		for (const outcome of ["BROKEN", "MISSING"]) {
			const r = judge([], ["k1"], outcome);
			expect(r.added).toBeNull();
			expect(r.stamp).toBe(`unexamined:1:${JSON.stringify(["k1"])}`);
		}
	});
});

describe("the outcome tests", () => {
	it("split every outcome one way", () => {
		const of = (o: string) => [isCompleted(o), isUnexamined(o), isJudged(o)];
		expect(of("OK")).toEqual([true, false, true]);
		expect(of("WARN")).toEqual([true, false, true]);
		expect(of("FAIL")).toEqual([true, false, true]);
		expect(of("BROKEN")).toEqual([false, true, true]);
		expect(of("MISSING")).toEqual([false, true, true]);
		expect(of("SKIP")).toEqual([false, false, false]);
	});
});
