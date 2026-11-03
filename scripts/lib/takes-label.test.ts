// @vitest-environment node
/*
 * Pins that takesLabel and takesValue refuse a value outside the takes: set,
 * naming it, so a script spelling a value the set has dropped fails at load
 * instead of matching no issue (#2193).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { takesLabel, takesRefusal, takesValue } from "./takes-label";

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

describe("takesRefusal's Close-when line (#4129)", () => {
	it("comes from the rule store", () => {
		const rules = fs.mkdtempSync(path.join(os.tmpdir(), "takes-label-rules-"));
		fs.writeFileSync(path.join(rules, "close-when-line.txt"), "CLOSE LINE.\n");
		process.env.WFC_RULES_DIR = rules;
		try {
			expect(
				takesRefusal(
					["takes:human"],
					"**Outside Claude Code:** email the hostel.",
				),
			).toContain("Add it — CLOSE LINE. Template:");
		} finally {
			delete process.env.WFC_RULES_DIR;
			fs.rmSync(rules, { recursive: true, force: true });
		}
	});
});
