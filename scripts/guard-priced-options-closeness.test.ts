// @vitest-environment node
/*
 * The closeness test lib/close-rivals.js exports (#472, #487).
 *
 * Called directly on the export, since `splitQuestions` and `rivalPair` are
 * pure functions of a round's text and need no transcript or hook payload.
 *
 * Two readers share it: the close-rivals refusal at every `Stop` and
 * `check-band-drift.js` under `npm run status`. A wrong verdict refuses rounds
 * whose rivals are far apart, or lets close ones through, and skews the drift
 * count meant to catch agents narrowing their bands.
 */

import { describe, expect, it } from "vitest";

const { CLOSE_GAP, rivalPair } = require("./lib/close-rivals.js");
const { splitQuestions } = require("./lib/round-marker.js");

type Opt = [string, number, number, number] | [string, string];

function pair(opts: Opt[], relation = "rivals for one slot") {
	const text = [
		"❓ **Q1** Which one?",
		"",
		...opts.flatMap((o) => [
			`(${o[0]}) option ${o[0]}`,
			o.length === 2
				? `Confidence: ${o[1]}.`
				: `Confidence: ${o[1]}% (${o[2]}% - ${o[3]}%). drives it`,
			"",
		]),
		`Relation: ${relation}.`,
	].join("\n");
	const blocks = splitQuestions(text);
	expect(blocks).toHaveLength(1);
	return rivalPair(blocks[0]);
}

describe("when a rival pair is close", () => {
	it("is close on overlapping bands alone, the gap being over the floor", () => {
		const p = pair([
			["A", 64, 50, 78],
			["B", 36, 22, 50],
		]);
		expect(p.gap).toBeGreaterThan(CLOSE_GAP);
		expect(p.overlap).toBe(true);
		expect(p.close).toBe(true);
	});

	it("is close on a gap at the floor alone, however narrow the bands", () => {
		const low = 30;
		const top = low + CLOSE_GAP;
		const p = pair([
			["A", top, top - 1, top + 1],
			["B", low, low - 1, low + 1],
		]);
		expect(p.gap).toBe(CLOSE_GAP);
		expect(p.overlap).toBe(false);
		expect(p.close).toBe(true);
	});

	it("is not close past the floor with bands apart", () => {
		const p = pair([
			["A", 64, 57, 71],
			["B", 36, 29, 43],
		]);
		expect(p.close).toBe(false);
	});

	it("takes the top two of three by figure, ties in letter order", () => {
		const p = pair([
			["A", 20, 10, 30],
			["B", 40, 30, 50],
			["C", 40, 35, 45],
		]);
		expect([p.top.letter, p.runnerUp.letter]).toEqual(["B", "C"]);
		expect(p.gap).toBe(0);
	});

	it("reads a band written high end first", () => {
		const p = pair([
			["A", 64, 71, 57],
			["B", 36, 43, 29],
		]);
		expect(p.top).toMatchObject({ low: 57, high: 71 });
		expect(p.overlap).toBe(false);
	});
});

describe("what is not a rival pair", () => {
	it("is none where the relation names a combinable pair", () => {
		expect(
			pair(
				[
					["A", 55, 45, 65],
					["B", 45, 35, 55],
				],
				"rivals, though (A) can run alongside (B)",
			),
		).toBeNull();
	});

	it("is none where the relation declares no rivals", () => {
		expect(
			pair(
				[
					["A", 55, 45, 65],
					["B", 45, 35, 55],
				],
				"independent, so any combination is takeable",
			),
		).toBeNull();
	});

	it("drops an option declared unknowable, leaving no pair", () => {
		expect(
			pair([
				["A", 55, 45, 65],
				["B", "unknowable — it turns on the founder's taste"],
			]),
		).toBeNull();
	});

	it("compares the priced options left after an unknowable one drops", () => {
		const p = pair([
			["A", "subjective"],
			["B", 60, 50, 70],
			["C", 40, 30, 50],
		]);
		expect([p.top.letter, p.runnerUp.letter]).toEqual(["B", "C"]);
	});
});
