// @vitest-environment node
/*
 * lib/launch-charge.js (#4911): the peak each run kind is charged against a
 * memory rung. Break a row and every admitter reading that kind admits a
 * launch short, into the 10 GB cap, or holds one back for memory it never
 * draws.
 *
 * The one place each figure is pinned as a literal: the callers' tests ask
 * this module by kind, so they check classification, never a figure.
 */
import { describe, expect, it } from "vitest";
import { chargeMb } from "./launch-charge";

const named = (n: number) =>
	Array.from({ length: n }, (_, i) => `scripts/a${i}.test.ts`);

describe("lib/launch-charge.js", () => {
	it.each([
		["a whole suite (#4592)", { kind: "suite" }, 1929],
		[
			"a part-suite on its line (#3806)",
			{ kind: "part", files: 10, workers: 3 },
			380 + 175 * 3 + 3 * 10,
		],
		[
			"a part-suite never above the whole suite",
			{ kind: "part", files: 400, workers: 5 },
			1929,
		],
		["pytest at no workers (#4112)", { kind: "pytest", workers: 0 }, 150],
		["pytest at 8 workers", { kind: "pytest", workers: 8 }, 150 + 75 * 8],
		["`node --test`", { kind: "node-test" }, 381],
		["`next build`", { kind: "next-build" }, 979],
		["a type-check (#4849)", { kind: "tsc" }, 2045],
		["a lander's whole run (#3323)", { kind: "lander", files: [] }, 2630],
		[
			"a lander's named run of one file",
			{ kind: "lander", files: named(1) },
			940,
		],
		[
			"a lander's named run of six files",
			{ kind: "lander", files: named(6) },
			940,
		],
		[
			"a lander's named run past six files, whole (#3973)",
			{ kind: "lander", files: named(7) },
			2630,
		],
	] as const)("charges %s", (_, launch, mb) => {
		expect(chargeMb(launch)).toBe(mb);
	});
});
