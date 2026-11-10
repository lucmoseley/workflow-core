// @vitest-environment node
/*
 * lib/narrowing-refusal.js: the one refusal both runners print where
 * narrowing failed (#4777).
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const load = createRequire(__filename);
const { NARROWING_LINE, narrowingRefusal } = load("./narrowing-refusal.js");

describe("narrowingRefusal", () => {
	it("leads with the headline, the ruling and the trimmed cause, and ends on the whole-suite command", () => {
		expect(
			narrowingRefusal({
				ruling: "#2934",
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
			narrowingRefusal({ ruling: "#2698", cause: "no base", wholeSuite: "x" }),
		).toContain(`${NARROWING_LINE} (#2698) — no base\n`);
	});
});
