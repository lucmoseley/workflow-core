// @vitest-environment node
/*
 * Pins when heresy-sweep.js finds a sweep due, over a fake tracker (#3464),
 * and how it reads what a finished sweep filed from the due issue's comments
 * (#4039). report-heresy-sweep-due.test.ts holds the program's boundary cases.
 * Built on a fake tracker port and a fixed clock, so no case reaches `gh` or
 * waits on time. Breaking it files the monthly sweep early, late or never.
 */

import { describe, expect, it } from "vitest";
import { judgeSweep, parseFiledHeresies } from "./heresy-sweep.js";

const DAY = 24 * 3_600_000;
const NOW = Date.parse("2026-06-30T12:00:00Z");
const issue = (number: number, createdAt: string, closedAt: string | null) => ({
	number,
	createdAt,
	closedAt,
});

describe("judgeSweep", () => {
	/** A fake tracker answering each state, recording what was asked. */
	const tracker = (
		answers: Partial<Record<"closed" | "open", ReturnType<typeof issue>>>,
	) => {
		const asked: string[] = [];
		const find = (state: "closed" | "open") => {
			asked.push(state);
			return answers[state] ?? null;
		};
		return { asked, find };
	};

	it("is due at once where no due issue was ever filed, asking both states", () => {
		const { asked, find } = tracker({});
		expect(judgeSweep(find, NOW)).toEqual({
			due: true,
			last: "none",
			next: null,
			why: "no *Heresy sweep due* issue was ever filed",
		});
		expect(asked).toEqual(["closed", "open"]);
	});

	it("dates from the newest close, never asking for the open issue", () => {
		const { asked, find } = tracker({
			closed: issue(5, "2026-05-01T00:00:00Z", "2026-06-10T09:00:00Z"),
			open: issue(9, "2026-04-01T00:00:00Z", null),
		});
		expect(judgeSweep(find, NOW)).toEqual({
			due: false,
			last: "#5, closed 2026-06-10",
			next: "2026-07-10",
			why: "under 30 days since 2026-06-10",
		});
		expect(asked).toEqual(["closed"]);
	});

	it("dates from the open issue's filing where none has closed", () => {
		const { find } = tracker({
			open: issue(9, "2026-05-01T00:00:00Z", null),
		});
		expect(judgeSweep(find, NOW)).toEqual({
			due: true,
			last: "none closed; #9 open since 2026-05-01",
			next: "2026-05-31",
			why: "30 days have passed since 2026-05-01",
		});
	});

	it("falls due exactly 30 days after the close, not a millisecond before", () => {
		const closedAt = new Date(NOW - 30 * DAY).toISOString();
		const at = (nowMs: number) =>
			judgeSweep(tracker({ closed: issue(5, closedAt, closedAt) }).find, nowMs)
				.due;
		expect(at(NOW)).toBe(true);
		expect(at(NOW - 1)).toBe(false);
	});
});

describe("parseFiledHeresies", () => {
	it.each([
		["a plural", ["**Filed:** 12 heresies: #8"], { count: 12 }],
		["none filed", ["**Filed:** 0 heresies: none"], { count: 0 }],
		["a singular", ["**Filed:** 1 heresy: #8 (gloss)"], { count: 1 }],
		[
			"a later Filed line over an earlier one",
			["**Filed:** 12 heresies: #8", "**Filed:** 11 heresies: #9"],
			{ count: 11 },
		],
		[
			"a line among a comment's others, a later comment carrying none",
			[
				"**Filed:** 2 heresies: #8",
				"Bound: all\n\n**Filed:** 5 heresies: #9",
				"A note.",
			],
			{ count: 5 },
		],
		["no comments", [], { unknown: "#7 has no **Filed:** comment" }],
		[
			"a mention mid-line, or a Filed line with no figure",
			["Read the **Filed:** 3 heresies line.", "**Filed:** some heresies"],
			{ unknown: "#7 has no **Filed:** comment" },
		],
	])("reads %s", (_name, bodies, expected) => {
		const comments = bodies.map((body) => ({ body }));
		expect(parseFiledHeresies(7, comments)).toEqual(expected);
	});
});
