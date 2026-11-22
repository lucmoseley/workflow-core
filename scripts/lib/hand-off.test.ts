// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	buildHandOffComment,
	handOffFaults,
	parseHandOff,
} from "./hand-off.js";

const DIFF = [
	"diff --git a/scripts/x.js b/scripts/x.js",
	"--- a/scripts/x.js",
	"+++ b/scripts/x.js",
	"@@ -1 +1 @@",
	"-old",
	"+new",
	"",
].join("\n");

const comment = (over = {}) =>
	buildHandOffComment({
		head: "**Refill loop:** stopped job1.",
		narration: "USER: /implement 7\nA: Reading the ticket.",
		base: "abc1234",
		done: "none",
		left: "continue /implement 7 from the narration",
		blockedOn: "nothing",
		files: ["scripts/x.js"],
		diff: DIFF,
		...over,
	});

describe("buildHandOffComment (#2659)", () => {
	it("ends in a block read-hand-off reads as well formed, with its diff", () => {
		const body = comment() ?? "";
		expect(handOffFaults(body)).toEqual([]);
		expect(parseHandOff(body)).toMatchObject({
			uncommitted: ["scripts/x.js"],
			diff: DIFF,
			fields: { Base: "abc1234", Done: "none" },
		});
		expect(body).toMatch(/^\*\*Refill loop:\*\* stopped job1\.\n\n<details>/);
		expect(body).toContain("A: Reading the ticket.");
	});

	it("writes `Uncommitted: none` and no diff where no file is uncommitted", () => {
		const body = comment({ files: [], diff: "" }) ?? "";
		expect(handOffFaults(body)).toEqual([]);
		expect(parseHandOff(body)).toMatchObject({ uncommitted: [], diff: null });
	});

	it("keeps the newest narration lines that fit under the limit", () => {
		const narration = Array.from(
			{ length: 8000 },
			(_, i) => `A: line ${i}`,
		).join("\n");
		const body = comment({ narration }) ?? "";
		expect(body.length).toBeLessThanOrEqual(65_536);
		expect(body).toContain("A: line 7999");
		expect(body).not.toContain("A: line 0\n");
		expect(handOffFaults(body)).toEqual([]);
	});

	it("fences a narration that quotes a fence past its own", () => {
		const body = comment({ narration: "A: ran ```diff\nA: and ````x````" });
		expect(body).toContain("`````text");
		expect(handOffFaults(body ?? "")).toEqual([]);
	});

	it("is null where the diff alone runs past the limit", () => {
		const diff = `${DIFF}${"+x\n".repeat(30_000)}`;
		expect(comment({ diff })).toBeNull();
	});
});
