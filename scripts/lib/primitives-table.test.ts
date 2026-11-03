// @vitest-environment node
/*
 * Pins how primitives-table.js reads a check's --json output into a breach
 * count (#4119). check-primitives.test.ts holds the program's boundary cases.
 */

import { describe, expect, it } from "vitest";
import { parseBreaches } from "./primitives-table.js";

const envelope = (fields: Record<string, unknown>) => JSON.stringify(fields);

describe("parseBreaches", () => {
	it("counts FAIL findings and no WARN", () => {
		const findings = [
			{ severity: "FAIL" },
			{ severity: "WARN" },
			{ severity: "FAIL" },
		];
		expect(parseBreaches(envelope({ outcome: "WARN", findings }), 0)).toEqual({
			count: 2,
		});
	});

	it("reads a SKIP with empty findings as 0 (#4119)", () => {
		expect(
			parseBreaches(envelope({ outcome: "SKIP", findings: [] }), 0),
		).toEqual({ count: 0 });
	});

	it("keeps a SKIP with no findings array unknown (#4119)", () => {
		expect(parseBreaches(envelope({ outcome: "SKIP" }), 0)).toEqual({
			unknown: "its envelope carries no findings array",
		});
	});

	it("keeps a BROKEN unknown, findings or none", () => {
		expect(
			parseBreaches(envelope({ outcome: "BROKEN", findings: [] }), 2),
		).toEqual({ unknown: "it answered BROKEN" });
	});

	it("keeps output that is no envelope unknown, naming the exit", () => {
		expect(parseBreaches("not json", 2)).toEqual({
			unknown: "it printed no --json envelope (exit 2)",
		});
		expect(parseBreaches("null", 0)).toEqual({
			unknown: "its envelope carries no findings array",
		});
	});
});
