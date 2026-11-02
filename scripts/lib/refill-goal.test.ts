// @vitest-environment node
/*
 * The refill loop's goal refs (#3864): what `set` reads a typed ref as, and
 * which ticked repo it lands in. Loosen one and a number lands in the wrong repo.
 */
import { describe, expect, it } from "vitest";
import { parseAskedRefs, qualifyRefs } from "./refill-goal.js";

describe("a typed ref", () => {
	it("reads N, #N and <repo>#N, by comma or space", () => {
		expect(parseAskedRefs("12,#13 core#14")).toEqual([
			{ repo: null, number: 12 },
			{ repo: null, number: 13 },
			{ repo: "core", number: 14 },
		]);
	});

	it.each(["", "soon", "drain #5", "#0", "core#", "a/b#1", "core#1#2"])(
		"reads %j as no list of refs",
		(text) => {
			expect(parseAskedRefs(text)).toBeNull();
		},
	);
});

describe("a ref's repo", () => {
	const bare = { repo: null, number: 5 };

	it("is the one ticked repo for a bare #N, each ref once", () => {
		expect(
			qualifyRefs([bare, { repo: "core", number: 5 }], ["/home/u/core"]),
		).toEqual([{ repo: "core", number: 5 }]);
	});

	it("refuses a bare #N unless exactly one repo is ticked", () => {
		for (const roots of [[], ["/home/u/core", "/home/u/manta"]])
			expect(qualifyRefs([bare], roots)).toContain(
				`#5 names no repo with ${roots.length} repos ticked`,
			);
	});

	it("refuses a ref to an unticked repo, naming it", () => {
		expect(
			qualifyRefs([{ repo: "manta", number: 5 }], ["/home/u/core"]),
		).toContain("tick manta first");
	});
});
