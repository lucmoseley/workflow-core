import { describe, expect, it } from "vitest";
import { EXEMPT_MARKERS, exemptMarker } from "./exempt-markers.js";

describe("exemptMarker", () => {
	it.each([
		"cli-args-exempt: #4820",
		"// cli-args-exempt: lucmoseley/mantahostels#12",
		"// cli-args-exempt: workflow-core#12",
		"/* cli-args-exempt: ADR-0007 */",
		"# cli-args-exempt: RFC9110",
	])("reads %s", (line) => {
		expect(exemptMarker("cli-args").test(line)).toBe(true);
	});

	it.each([
		"cli-args-exempt:",
		"cli-args-exempt: #",
		"cli-args-exempt: a pass-through wrapper",
		"cli-args-exempt: #12abc",
		"cli-args-exempt: repo#12",
	])("refuses %s", (line) => {
		expect(exemptMarker("cli-args").test(line)).toBe(false);
	});

	it.each([
		"cli-args-exempt: x-workflow-core#12",
		"cli-args-exempt: a.workflow-core#12",
	])(
		"refuses %s, a workflow-core#N pointer joined on its left (#5694; pair: reads // cli-args-exempt: workflow-core#12)",
		(line) => {
			expect(exemptMarker("cli-args").test(line)).toBe(false);
		},
	);

	it("never reads one marker inside a longer name", () => {
		expect(exemptMarker("citation").test("bare-citation-exempt: #435")).toBe(
			false,
		);
		expect(
			exemptMarker("bare-citation").test("bare-citation-exempt: #435"),
		).toBe(true);
	});

	it("throws, naming the unregistered marker", () => {
		expect(EXEMPT_MARKERS).not.toContain("foo");
		expect(() => exemptMarker("foo" as never)).toThrow(
			"foo-exempt: is no registered marker",
		);
	});
});
