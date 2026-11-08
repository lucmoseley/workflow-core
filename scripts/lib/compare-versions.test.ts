// @vitest-environment node
/*
 * The shared version comparer (#4091). Loosened, a later release reads as
 * older, or a version with an extra component never compares equal.
 */
import { describe, expect, it } from "vitest";

const { compareVersions } = require("./compare-versions.js") as {
	compareVersions: (a: number[], b: number[]) => number;
};

describe("ordering two versions by numeric part", () => {
	it.each([
		[[1, 2, 3], [1, 2, 3], 0],
		[[1, 10, 0], [1, 9, 9], 1],
		[[1, 9, 9], [1, 10, 0], -1],
		[[2, 0, 0], [1, 99, 99], 1],
		[[2, 6, 1, 0], [2, 6, 1], 0],
		[[2, 6, 1], [2, 6, 1, 1], -1],
		[[2, 6, 1, 2], [2, 6, 1], 1],
	])("%j against %j has sign %d", (a, b, sign) => {
		expect(Math.sign(compareVersions(a, b))).toBe(sign);
	});
});
