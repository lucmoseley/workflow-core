/*
 * lib/issue-number.js, the one reader of an issue-number argument (#3372).
 * Loosen it and every script taking one passes a non-number into a gh call.
 */

import { describe, expect, it } from "vitest";
import { parseIssueNumber, parseIssueNumbers } from "./issue-number.js";

describe("parseIssueNumber", () => {
	it.each([
		["123", 123],
		["#123", 123],
		[" #7 ", 7],
		["#", null],
		["12a", null],
		["1.5", null],
		["##3", null],
		["", null],
		[undefined, null],
	])("reads %j as %j", (value, want) => {
		expect(parseIssueNumber(value)).toBe(want);
	});
});

describe("parseIssueNumbers", () => {
	it("reads each comma- or space-separated word, null for a non-number", () => {
		expect(parseIssueNumbers("#1, 2 x,#3")).toEqual([1, 2, null, 3]);
		expect(parseIssueNumbers("")).toEqual([]);
	});
});
