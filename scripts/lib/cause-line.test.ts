import { describe, expect, it } from "vitest";
import { buildCauseLine, parseCauseShas } from "./cause-line";

const A = "92d78df557aa843d6cbf08f1db5c2792003a5853";
const B = "6a33d61d0";

describe("parseCauseShas (#5781)", () => {
	it("returns every sha a comma-separated line names", () => {
		expect(parseCauseShas(`**Caused by:** ${A}, ${B}`)).toEqual([A, B]);
	});

	it("finds a line inside a longer body, and every line in it", () => {
		const body = [
			"## Triage",
			"",
			"Bisected the range.",
			`**Caused by:** \`${B}\``,
			"",
			`- **Caused by:** ${A.slice(0, 7)}`,
			"Nothing else here.",
		].join("\n");
		expect(parseCauseShas(body)).toEqual([B, A.slice(0, 7)]);
	});

	it("ignores tokens under 7 hex, non-hex tokens and issue refs", () => {
		expect(
			parseCauseShas("**Caused by:** abc123, 6a33d6g0x, #5745, o/t#12"),
		).toEqual([]);
	});

	it("stops at the first token that is not a sha, so prose blames nothing", () => {
		expect(
			parseCauseShas(
				`**Caused by:** ${B}. Bisected to Stop the boom (${A.slice(0, 9)}).`,
			),
		).toEqual([B]);
		expect(
			parseCauseShas(`**Caused by:** not ${B}, it predates the red`),
		).toEqual([]);
	});

	it("reads no sha off a marker that does not open its line", () => {
		expect(
			parseCauseShas(`The triage wrongly wrote **Caused by:** ${B}`),
		).toEqual([]);
	});

	it("reads no sha off a line without the marker", () => {
		expect(
			parseCauseShas(`Since ${B} the lander hangs. Caused by ${A}.`),
		).toEqual([]);
	});

	it("parses back the line buildCauseLine writes", () => {
		expect(parseCauseShas(buildCauseLine([A, B]))).toEqual([A, B]);
	});
});
