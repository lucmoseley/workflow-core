// @vitest-environment node
/*
 * lib/narrowing-refusal.js, called in-process and pinned byte for byte: the
 * runners' own tests pin only the refusal's first words, so a reworded
 * remedy or a lost whole-suite command would pass unseen in both (#4777).
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const load = createRequire(__filename);
const { narrowingRefusal } = load("./narrowing-refusal.js");

describe("narrowingRefusal", () => {
	it("leads with the headline, the ruling and the trimmed cause, and ends on the whole-suite command", () => {
		expect(
			narrowingRefusal({
				ruling: "(#2934)",
				cause: new Error(" git would not say \n"),
				wholeSuite: "npm run test:py -- scripts",
			}),
		).toBe(
			"\nNARROWING FAILED, SO NOTHING RAN (#2934) — git would not say\n\n" +
				"A failed narrowing is never widened to the whole suite. Fix the cause and re-run, or run the whole suite on purpose:\n\n" +
				"  npm run test:py -- scripts\n\n",
		);
	});

	it("prints a cause that is no Error as its string", () => {
		expect(
			narrowingRefusal({
				ruling: "(#2698)",
				cause: "no base",
				wholeSuite: "x",
			}),
		).toContain("NARROWING FAILED, SO NOTHING RAN (#2698) — no base\n");
	});
});
