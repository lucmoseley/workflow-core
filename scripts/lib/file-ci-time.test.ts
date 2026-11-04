// @vitest-environment node

import { describe, expect, it } from "vitest";

const { SWEEPS_JUDGED, collect, judge } = require("./file-ci-time.js");

type Rows = Record<string, number | null>;
const sweep = (run: string, rows: Rows) => ({
	run,
	rows: Object.entries(rows).map(([file, seconds]) => ({ file, seconds })),
});

describe("judge", () => {
	it("names a file whose median of three is over the limit, slowest first, and not one at it", () => {
		const v = judge([
			sweep("3", { a: 61, b: 200, c: 60, d: 10 }),
			sweep("2", { a: 90, b: 70, c: 60, d: 300 }),
			sweep("1", { a: 10, b: 80, c: 99, d: 20 }),
		]);
		expect(v.judged).toBe(true);
		expect(
			v.over.map((f: { file: string; medianSeconds: number }) => [
				f.file,
				f.medianSeconds,
			]),
		).toEqual([
			["b", 80],
			["a", 61],
		]);
		expect(v.over[0].readings).toEqual([
			{ run: "3", seconds: 200 },
			{ run: "2", seconds: 70 },
			{ run: "1", seconds: 80 },
		]);
	});

	it("judges a file missing from a sweep on the latest three sweeps it ran in", () => {
		const v = judge([
			sweep("4", { a: 100, b: 1 }),
			sweep("3", { b: 1 }),
			sweep("2", { a: 100, b: 1 }),
			sweep("1", { a: 10, b: 1 }),
		]);
		expect(v.over).toEqual([
			{
				file: "a",
				medianSeconds: 100,
				readings: [
					{ run: "4", seconds: 100 },
					{ run: "2", seconds: 100 },
					{ run: "1", seconds: 10 },
				],
			},
		]);
		expect(v.unjudged).toEqual([]);
	});

	it("leaves a file with fewer than three readings unjudged, and an untimed row is no reading", () => {
		const v = judge([
			sweep("3", { a: 500, b: 1 }),
			sweep("2", { a: null, b: 1 }),
			sweep("1", { b: 1 }),
		]);
		expect(v.over).toEqual([]);
		expect(v.unjudged).toEqual([
			{
				file: "a",
				readings: [{ run: "3", seconds: 500 }],
				overInASweep: true,
			},
		]);
	});

	it("drops a file timed in none of the latest three sweeps", () => {
		const v = judge([
			sweep("4", { b: 1 }),
			sweep("3", { b: 1 }),
			sweep("2", { b: 1 }),
			sweep("1", { gone: 500 }),
		]);
		expect(v.over).toEqual([]);
		expect(v.unjudged).toEqual([]);
	});

	it(`judges nothing with fewer than ${SWEEPS_JUDGED} sweeps`, () => {
		expect(judge([sweep("2", { a: 500 }), sweep("1", { a: 500 })])).toEqual({
			judged: false,
			runs: ["2", "1"],
		});
	});
});

describe("collect", () => {
	const reader = (sweeps: Record<string, Rows | null>) => {
		const asked: string[] = [];
		return {
			asked,
			read: (run: string) => {
				asked.push(run);
				const rows = sweeps[run];
				return rows ? sweep(run, rows) : null;
			},
		};
	};

	const runsOf = (c: { sweeps: { run: string }[] }) =>
		c.sweeps.map((x) => x.run);

	it("reads three sweeps and stops when no file is short", () => {
		const r = reader({
			"5": { a: 1 },
			"4": { a: 1 },
			"3": { a: 1 },
			"2": { a: 1 },
		});
		expect(runsOf(collect(["5", "4", "3", "2"], r.read))).toEqual([
			"5",
			"4",
			"3",
		]);
		expect(r.asked).toEqual(["5", "4", "3"]);
	});

	it("passes over a run with no reports, and names it", () => {
		const r = reader({
			"5": { a: 1 },
			"4": null,
			"3": { a: 1 },
			"2": { a: 1 },
		});
		const c = collect(["5", "4", "3", "2"], r.read);
		expect(runsOf(c)).toEqual(["5", "3", "2"]);
		expect(c.passedOver).toEqual(["4"]);
	});

	it("reads past two sweeps in a row missing a file to the one that holds it", () => {
		const r = reader({
			"7": { a: 1, b: 1 },
			"6": { b: 1 },
			"5": { b: 1 },
			"4": { b: 1 },
			"3": { a: 1, b: 1 },
			"2": { a: 1, b: 1 },
			"1": { a: 1, b: 1 },
		});
		const c = collect(["7", "6", "5", "4", "3", "2", "1"], r.read);
		expect(r.asked).toEqual(["7", "6", "5", "4", "3", "2"]);
		expect(judge(c.sweeps).unjudged).toEqual([]);
	});

	it("reads no more than 8 sweeps", () => {
		const runs = Array.from({ length: 12 }, (_, i) => String(100 - i));
		const rows: Record<string, Rows> = {};
		/* `fresh` is only in the newest, so every older read leaves it short. */
		for (const [i, run] of runs.entries())
			rows[run] = i === 0 ? { a: 1, fresh: 1 } : { a: 1 };
		expect(collect(runs, reader(rows).read).sweeps).toHaveLength(8);
	});
});
