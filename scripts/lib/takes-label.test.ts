// @vitest-environment node
/*
 * Pins that takesLabel and takesValue refuse a value outside the takes: set,
 * naming it, so a script spelling a value the set has dropped fails at load
 * instead of matching no issue (#2193).
 */

import { describe, expect, it } from "vitest";
import { takesLabel, takesValue } from "./takes-label";

describe("a takes: value a script names", () => {
	it("builds the label for one of the seven", () => {
		expect(takesLabel("triage")).toBe("takes:triage");
		expect(takesValue("triage")).toBe("triage");
	});

	it("throws for a value outside the seven, naming the value (#2193)", () => {
		expect(() => takesLabel("retired")).toThrow(
			/retired is not a takes: value/,
		);
		expect(() => takesValue("retired")).toThrow(
			/retired is not a takes: value/,
		);
	});
});
