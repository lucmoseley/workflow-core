import { describe, expect, it } from "vitest";

const {
	agePointsOf,
	compareLevels,
	mergeFrontiers,
} = require("./frontier-order.js");

const row = (number: number, over: Record<string, unknown> = {}) => ({
	number,
	bug: false,
	urgent: false,
	goal: false,
	stallDays: 0,
	asksQuestions: false,
	depth: 0,
	closes: 0,
	agePoints: 0,
	reach: 0,
	collision: "comment-only",
	...over,
});
const ranked = ({
	frontier,
}: {
	frontier: { root: string; number: number }[];
}) => frontier.map((r) => `${r.root}#${r.number}`);

describe("compareLevels", () => {
	it("puts a longer stalled wait above a shorter one, not only a stall above none", () => {
		expect(
			[row(1, { stallDays: 20 }), row(2, { stallDays: 60 }), row(3)]
				.sort(compareLevels)
				.map((r) => r.number),
		).toEqual([2, 1, 3]);
	});
});

const NOW = Date.parse("2026-11-28T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const aged = (
	number: number,
	days: number,
	over: Record<string, unknown> = {},
) =>
	row(number, {
		createdAt: daysAgo(days),
		agePoints: agePointsOf(daysAgo(days), NOW),
		...over,
	});
const order = (rows: ReturnType<typeof row>[]) =>
	[...rows].sort(compareLevels).map((r) => r.number);

describe("age points (#5880)", () => {
	it("gives one point per full week: none at 6 days, one at 7 and still one at 13", () => {
		expect([6, 7, 13, 14, 21].map((d) => agePointsOf(daysAgo(d), NOW))).toEqual(
			[0, 1, 1, 2, 3],
		);
		expect(order([row(1, { depth: 1 }), aged(2, 7)])).toEqual([1, 2]);
		expect(order([row(1, { depth: 1 }), aged(2, 7, { reach: 1 })])).toEqual([
			2, 1,
		]);
		expect(order([row(1, { depth: 1, reach: 1 }), aged(2, 13)])).toEqual([
			1, 2,
		]);
	});

	it("gives a missing or unreadable createdAt no points, never an error", () => {
		expect(
			[undefined, null, "", "not a date"].map((c) => agePointsOf(c, NOW)),
		).toEqual([0, 0, 0, 0]);
	});

	it("ranks a 6-day row exactly as with no age term", () => {
		expect(order([aged(1, 6), row(2, { reach: 1 })])).toEqual([2, 1]);
		expect(order([aged(1, 6, { reach: 1 }), row(2)])).toEqual([1, 2]);
	});

	it("lifts a 21-day leaf over depth plus closes of 2, not over 4", () => {
		expect(order([row(1, { depth: 1, closes: 1 }), aged(2, 21)])).toEqual([
			2, 1,
		]);
		expect(order([row(1, { depth: 2, closes: 2 }), aged(2, 21)])).toEqual([
			1, 2,
		]);
	});

	it("never lifts a row over bug, urgent, goal, a stall or a question type", () => {
		for (const over of [
			{ bug: true },
			{ urgent: true },
			{ goal: true },
			{ stallDays: 8 },
			{ asksQuestions: true },
		])
			expect(order([aged(1, 700), row(2, over)])).toEqual([2, 1]);
	});

	it("ranks an aged row above a younger one with greater reach", () => {
		expect(order([row(1, { reach: 9 }), aged(2, 7)])).toEqual([2, 1]);
	});

	it("lets an old row in one repo beat a younger, deeper row in another once its points pass the depth gap", () => {
		const merged = mergeFrontiers([
			{
				root: "busy",
				lastLaunchAt: null,
				retroBundles: [],
				rows: [aged(1, 1, { depth: 2 })],
			},
			{
				root: "quiet",
				lastLaunchAt: null,
				retroBundles: [],
				rows: [aged(5, 21), aged(6, 13)],
			},
		]);
		expect(ranked(merged)).toEqual(["quiet#5", "busy#1", "quiet#6"]);
	});

	it("falls an equal score through to the oldest createdAt", () => {
		const merged = mergeFrontiers([
			{
				root: "a",
				lastLaunchAt: null,
				retroBundles: [],
				rows: [aged(1, 10, { depth: 1 }), aged(2, 15)],
			},
		]);
		expect(ranked(merged)).toEqual(["a#2", "a#1"]);
	});

	it("falls an equal, undated score through launch time, number, then root", () => {
		const merged = mergeFrontiers([
			{
				root: "b",
				lastLaunchAt: 2000,
				retroBundles: [],
				rows: [row(1, { agePoints: 2 })],
			},
			{
				root: "c",
				lastLaunchAt: 1000,
				retroBundles: [],
				rows: [row(3, { depth: 1, agePoints: 1 })],
			},
			{
				root: "a",
				lastLaunchAt: 1000,
				retroBundles: [],
				rows: [row(3, { agePoints: 2 }), row(4, { closes: 2 })],
			},
		]);
		expect(ranked(merged)).toEqual(["a#3", "c#3", "a#4", "b#1"]);
	});
});

describe("mergeFrontiers (#2003)", () => {
	it("holds every sort level across repos: bug, urgent, goal, stalled wait, type, depth, reach, collision", () => {
		const merged = mergeFrontiers([
			{
				root: "a",
				lastLaunchAt: null,
				retroBundles: [],
				rows: [
					row(1, { collision: "writes repo files" }),
					row(2, { reach: 3 }),
					row(3, { stallDays: 4 }),
					row(9, { depth: 1 }),
				],
			},
			{
				root: "b",
				lastLaunchAt: null,
				retroBundles: [],
				rows: [
					row(4),
					row(5, { asksQuestions: true }),
					row(6, { goal: true }),
					row(7, { urgent: true }),
					row(8, { bug: true, urgent: true }),
				],
			},
		]);
		expect(ranked(merged)).toEqual([
			"b#8",
			"b#7",
			"b#6",
			"a#3",
			"b#5",
			"a#9",
			"a#2",
			"b#4",
			"a#1",
		]);
	});

	it("ranks on depth plus closes, not depth alone (#3613)", () => {
		const merged = mergeFrontiers([
			{
				root: "a",
				lastLaunchAt: null,
				retroBundles: [],
				rows: [
					row(1, { depth: 2, reach: 9 }),
					row(2, { depth: 2, closes: 1 }),
					row(3, { depth: 1, closes: 2, reach: 1 }),
				],
			},
		]);
		expect(ranked(merged)).toEqual(["a#3", "a#2", "a#1"]);
	});

	it("gives a full tie to the repo launched least recently, a never-launched repo first", () => {
		const merged = mergeFrontiers([
			{ root: "recent", lastLaunchAt: 2000, retroBundles: [], rows: [row(1)] },
			{ root: "older", lastLaunchAt: 1000, retroBundles: [], rows: [row(9)] },
			{ root: "never", lastLaunchAt: null, retroBundles: [], rows: [row(5)] },
		]);
		expect(ranked(merged)).toEqual(["never#5", "older#9", "recent#1"]);
	});

	it("gives a full tie to the oldest issue across repos, before the repo tie-break", () => {
		const merged = mergeFrontiers([
			{
				root: "older",
				lastLaunchAt: 1000,
				retroBundles: [],
				rows: [row(900, { createdAt: "2026-09-01T00:00:00Z" })],
			},
			{
				root: "recent",
				lastLaunchAt: 2000,
				retroBundles: [],
				rows: [row(3, { createdAt: "2026-01-01T00:00:00Z" })],
			},
		]);
		expect(ranked(merged)).toEqual(["recent#3", "older#900"]);
	});

	it("passes a row without a date to the repo tie-break", () => {
		const merged = mergeFrontiers([
			{ root: "recent", lastLaunchAt: 2000, retroBundles: [], rows: [row(1)] },
			{
				root: "older",
				lastLaunchAt: 1000,
				retroBundles: [],
				rows: [row(9, { createdAt: "2026-09-01T00:00:00Z" })],
			},
		]);
		expect(ranked(merged)).toEqual(["older#9", "recent#1"]);
	});

	it("passes a row without a date to the repo tie-break when its repo launched longer ago", () => {
		const merged = mergeFrontiers([
			{
				root: "recent",
				lastLaunchAt: 2000,
				retroBundles: [],
				rows: [row(1, { createdAt: "2026-01-01T00:00:00Z" })],
			},
			{ root: "older", lastLaunchAt: 1000, retroBundles: [], rows: [row(9)] },
		]);
		expect(ranked(merged)).toEqual(["older#9", "recent#1"]);
	});

	it("lets a higher sort level beat the repo tie-break", () => {
		const merged = mergeFrontiers([
			{ root: "older", lastLaunchAt: 1000, retroBundles: [], rows: [row(1)] },
			{
				root: "recent",
				lastLaunchAt: 2000,
				retroBundles: [],
				rows: [row(2, { reach: 1 })],
			},
		]);
		expect(ranked(merged)).toEqual(["recent#2", "older#1"]);
	});

	it("keeps each row's own fields and tags it with its root", () => {
		const {
			frontier: [only],
		} = mergeFrontiers([
			{
				root: "/h/r",
				lastLaunchAt: null,
				retroBundles: [],
				rows: [row(3, { title: "t", takes: ["implement"] })],
			},
		]);
		expect(only).toMatchObject({
			root: "/h/r",
			number: 3,
			title: "t",
			takes: ["implement"],
			collision: "comment-only",
		});
	});

	it("carries each repo's retro bundles whole, tagged with its root", () => {
		const bundle = { issues: [4, 5], model: "sonnet", prompt: "/triage 4 5" };
		const { retroBundles } = mergeFrontiers([
			{
				root: "a",
				lastLaunchAt: null,
				rows: [row(4), row(5)],
				retroBundles: [bundle],
			},
			{ root: "b", lastLaunchAt: null, rows: [], retroBundles: [] },
		]);
		expect(retroBundles).toEqual([{ root: "a", ...bundle }]);
	});
});
