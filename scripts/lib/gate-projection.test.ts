// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const {
	DAY_MS,
	appendReading,
	project,
	readHistory,
	reachableFloor,
} = require("./gate-projection.js");

const NOW = Date.parse("2026-11-28T00:00:00Z");
const daysAgo = (d: number) => NOW - d * DAY_MS;

type Point = [days: number, a: number, b?: number];

const rowsOf = (points: Point[], extra: Point[][] = []) =>
	points.map(([d, a, b = 15], i) => ({
		repo: "o/r",
		issue: 1,
		command: "c",
		at: daysAgo(d),
		counts: [
			{ a, b, since: daysAgo(d) },
			...extra.map((series) => {
				const [, xa, xb = 15] = series[i] ?? [d, 0];
				return { a: xa, b: xb, since: daysAgo(d) };
			}),
		],
	}));

describe("project", () => {
	it("reads met where every count reaches its floor", () => {
		expect(project([], [{ a: 15, b: 15 }], NOW)).toEqual({ verdict: "met" });
	});

	it("reads no-history on under a day of rows", () => {
		const p = project(rowsOf([[0.5, 1]]), [{ a: 1, b: 15 }], NOW);
		expect(p.verdict).toBe("no-history");
		expect(project([], [{ a: 1, b: 15 }], NOW).verdict).toBe("no-history");
	});

	it("reads on-track with a date inside the bound", () => {
		const p = project(
			rowsOf([
				[4, 2],
				[2, 6],
			]),
			[{ a: 10, b: 15 }],
			NOW,
		);
		expect(p.verdict).toBe("on-track");
		expect(p.ratePerDay).toBe(2);
		expect(p.metAt).toBe(NOW + 2.5 * DAY_MS);
	});

	it("reads unreachable at a slow rate, with a date and the remaining count", () => {
		const p = project(rowsOf([[10, 0]]), [{ a: 1, b: 15 }], NOW);
		expect(p).toMatchObject({
			verdict: "unreachable",
			remaining: 14,
			spanDays: 7,
		});
		expect(p.ratePerDay).toBeCloseTo(1 / 7);
		expect(p.metAt).toBe(NOW + 98 * DAY_MS);
	});

	it("reads unreachable at zero rate with no date, counting days unmoved from since", () => {
		const rows = rowsOf([[19, 0]]);
		rows.push({
			...rows[0],
			at: daysAgo(1),
			counts: [{ a: 0, b: 15, since: daysAgo(19) }],
		});
		const p = project(rows, [{ a: 0, b: 15 }], NOW);
		expect(p).toMatchObject({
			verdict: "unreachable",
			metAt: null,
			ratePerDay: 0,
			unmovedDays: 19,
		});
	});

	it("takes the rate over the trailing 7 days, so a rate that fell is the one judged", () => {
		const p = project(
			rowsOf([
				[20, 0, 50],
				[7, 26, 50],
			]),
			[{ a: 30, b: 50 }],
			NOW,
		);
		expect(p.ratePerDay).toBeCloseTo(4 / 7);
		expect(p.verdict).toBe("unreachable");
	});

	it("judges several counts on the slowest", () => {
		const p = project(
			rowsOf([[7, 0]], [[[7, 0]]]),
			[
				{ a: 14, b: 15 },
				{ a: 1, b: 15 },
			],
			NOW,
		);
		expect(p).toMatchObject({ verdict: "unreachable", a: 1, remaining: 14 });
	});

	it("resets a count's series where it fell, never reading a negative rate", () => {
		const p = project(
			rowsOf([
				[7, 40],
				[2, 0],
			]),
			[{ a: 4, b: 15 }],
			NOW,
		);
		expect(p.ratePerDay).toBe(2);
		expect(p.spanDays).toBe(2);
		expect(p.verdict).toBe("on-track");
	});
});

describe("reachableFloor", () => {
	it("gives the count the rate reaches within the bound", () => {
		expect(reachableFloor(3, 0.57)).toBe(6);
		expect(reachableFloor(3, 0)).toBe(3);
	});
});

describe("the history store", () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-history-"));
		file = path.join(dir, "h.jsonl");
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	const put = (at: number, reading: string, over: object = {}) =>
		appendReading({
			repo: "O/R",
			issue: 1,
			command: "c",
			reading,
			at,
			file,
			...over,
		});
	const read = (over: object = {}) =>
		readHistory({ repo: "o/r", issue: 1, command: "c", file, ...over });

	it("writes one unchanged row a day and every changed count", () => {
		put(daysAgo(3), "0 of 15");
		put(daysAgo(2.9), "0 of 15");
		put(daysAgo(2.8), "1 of 15");
		put(daysAgo(1.5), "1 of 15");
		expect(
			read().map((r: { counts: { a: number }[] }) => r.counts[0].a),
		).toEqual([0, 1, 1]);
	});

	it("carries since across unchanged rows", () => {
		put(daysAgo(5), "2 of 15");
		put(daysAgo(3), "2 of 15");
		put(daysAgo(1), "2 of 15");
		expect(
			read().map((r: { counts: { since: number }[] }) => r.counts[0].since),
		).toEqual([daysAgo(5), daysAgo(5), daysAgo(5)]);
	});

	it("prunes rows past 14 days, keeping each gate's newest row", () => {
		put(daysAgo(30), "1 of 15");
		put(daysAgo(29), "2 of 15");
		put(daysAgo(30), "5 of 9", { issue: 2 });
		put(daysAgo(0), "3 of 15", { issue: 3 });
		expect(read().map((r: { at: number }) => r.at)).toEqual([daysAgo(29)]);
		expect(read({ issue: 2 })).toHaveLength(1);
	});

	it("reads a missing file and a corrupt line as no rows", () => {
		expect(read()).toEqual([]);
		put(daysAgo(2), "1 of 15");
		fs.appendFileSync(file, "{not json\n");
		put(daysAgo(1), "2 of 15");
		expect(read()).toHaveLength(2);
	});

	it("writes no row for a reading with no count", () => {
		expect(put(daysAgo(1), "met: on main")).toBeNull();
		expect(fs.existsSync(file)).toBe(false);
	});

	it("falls back to the command's rows where the issue has none, and prefers the issue's own", () => {
		put(daysAgo(3), "1 of 15", { issue: null });
		put(daysAgo(2), "2 of 15", { issue: 7 });
		expect(
			read({ issue: 9 }).map((r: { issue: number | null }) => r.issue),
		).toEqual([null, 7]);
		put(daysAgo(1), "4 of 15", { issue: 9, command: "other" });
		expect(
			read({ issue: 9 }).map((r: { command: string }) => r.command),
		).toEqual(["other"]);
	});
});
