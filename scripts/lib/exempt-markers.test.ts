import { describe, expect, it } from "vitest";
import { EXEMPT_MARKERS, exemptMarker } from "./exempt-markers.js";

describe("exemptMarker", () => {
	it.each([
		"cli-args-exempt: #4820",
		"// cli-args-exempt: lucmoseley/mantahostels#12",
		"/* cli-args-exempt: ADR-0007 */",
	])("reads %s", (line) => {
		expect(exemptMarker("cli-args").test(line)).toBe(true);
	});

	it.each([
		"cli-args-exempt:",
		"cli-args-exempt: #",
		"cli-args-exempt: a pass-through wrapper",
	])("refuses %s", (line) => {
		expect(exemptMarker("cli-args").test(line)).toBe(false);
	});

	it("never reads one marker inside a longer name", () => {
		expect(exemptMarker("citation").test("bare-citation-exempt: #435")).toBe(
			false,
		);
		expect(
			exemptMarker("bare-citation").test("bare-citation-exempt: #435"),
		).toBe(true);
	});

	it("refuses a name no checker registers", () => {
		expect(EXEMPT_MARKERS).not.toContain("foo");
		expect(() => exemptMarker("foo" as never)).toThrow(
			"foo-exempt: is no registered marker",
		);
	});
});
