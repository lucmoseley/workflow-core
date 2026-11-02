// @vitest-environment node
/*
 * Pins how heresy-sweep.js reads what a finished sweep filed from the due
 * issue's comments (#4039).
 */

import { describe, expect, it } from "vitest";
import { parseFiledHeresies } from "./heresy-sweep.js";

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
