import { describe, expect, it } from "vitest";

const { mergeFrontiers } = require("./frontier-order.js");

const row = (number: number, over: Record<string, unknown> = {}) => ({
	number,
	bug: false,
	urgent: false,
	goal: false,
	stallDays: 0,
	asksQuestions: false,
	depth: 0,
	closes: 0,
	reach: 0,
	collision: "comment-only",
	...over,
});
const ranked = ({
	frontier,
}: {
	frontier: { root: string; number: number }[];
}) => frontier.map((r) => `${r.root}#${r.number}`);

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
