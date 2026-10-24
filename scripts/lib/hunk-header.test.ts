// @vitest-environment node
/*
 * hunk-header.test.ts — a hunk header: its new side, which the mutation
 * hold turns into Stryker's line ranges and the code-standards checker into
 * a citation's changed lines (#2379), and both sides read and rewritten, as
 * commit-paths renumbers a cut patch's hunks (#2486).
 *
 * In-process over a pure parser: no repo and no git, the header lines being
 * the whole input. A break lets the mutation hold mutate lines the commit did
 * not change, the checker attribute a citation's change to the wrong line, or
 * a --patch commit apply a hunk at the wrong line.
 */

import { describe, expect, it } from "vitest";
import { formatHeader, parseHeader, parseNewSide } from "./hunk-header.js";

describe("parseNewSide", () => {
	it("reads a start and a count", () => {
		expect(parseNewSide("@@ -3,2 +5,4 @@ function f() {")).toEqual({
			start: 5,
			count: 4,
		});
	});

	it("reads an omitted count as 1", () => {
		expect(parseNewSide("@@ -3 +7 @@")).toEqual({ start: 7, count: 1 });
	});

	it("reads a pure deletion as count 0", () => {
		expect(parseNewSide("@@ -4,2 +3,0 @@")).toEqual({ start: 3, count: 0 });
	});

	it("answers null for any other line", () => {
		expect(parseNewSide("+@@ -1 +1 @@")).toBeNull();
		expect(parseNewSide("diff --git a/x b/x")).toBeNull();
	});
});

describe("parseHeader", () => {
	it("reads both sides and the text after the header", () => {
		expect(parseHeader("@@ -3,2 +5,0 @@ function f() {")).toEqual({
			oldStart: 3,
			oldCount: 2,
			newStart: 5,
			newCount: 0,
			rest: " function f() {",
		});
	});

	it("reads an omitted count on either side as 1", () => {
		expect(parseHeader("@@ -3 +7 @@")).toMatchObject({
			oldCount: 1,
			newCount: 1,
		});
	});

	it("answers null for any other line", () => {
		expect(parseHeader("+@@ -1 +1 @@")).toBeNull();
		expect(parseHeader("diff --git a/x b/x")).toBeNull();
	});
});

describe("formatHeader", () => {
	it("writes back the header it read, a count of 1 omitted", () => {
		for (const line of [
			"@@ -3,2 +5,4 @@ function f() {",
			"@@ -3 +7 @@",
			"@@ -1,0 +1 @@",
			"@@ -4,2 +3,0 @@",
		]) {
			const h = parseHeader(line);
			expect(h).not.toBeNull();
			if (h) expect(formatHeader(h)).toBe(line);
		}
	});

	it("writes an explicit count of 1 in git's omitted form", () => {
		const h = parseHeader("@@ -3,1 +3,1 @@");
		expect(h).not.toBeNull();
		if (h) expect(formatHeader(h)).toBe("@@ -3 +3 @@");
	});
});
