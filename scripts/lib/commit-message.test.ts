// @vitest-environment node
/*
 * Pins a commit message file's stripped lines (#2884): `#` lines dropped, and
 * nothing from the scissors line on, so a `--verbose` diff below it never
 * reaches the closing or `Weakens:` scanners. A pure function on a string, so
 * in-process with no temp directory.
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const { strippedLines }: any = createRequire(__filename)("./commit-message.js");

describe("strippedLines", () => {
	it("drops git's # template lines", () => {
		expect(strippedLines("Subject\n# On branch main\n\nBody")).toEqual([
			"Subject",
			"",
			"Body",
		]);
	});

	it("stops at the scissors line, keeping nothing of the diff below it", () => {
		const raw =
			"Subject\n# ------------------------ >8 ------------------------\n# Do not modify\n+Fixes #12";
		expect(strippedLines(raw)).toEqual(["Subject"]);
	});

	it("keeps a line that only mentions >8 without the scissors shape", () => {
		expect(strippedLines("a >8 b")).toEqual(["a >8 b"]);
	});
});
