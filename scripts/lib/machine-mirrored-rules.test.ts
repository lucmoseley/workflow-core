// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MIRRORED_SECTIONS, mirroredBytes } from "./machine-mirrored-rules.js";

const [first = ""] = MIRRORED_SECTIONS;

describe("mirroredBytes (#5683)", () => {
	it("counts a mirrored section from its heading to the next H2", () => {
		const section = `## ${first}\n\nrule\n\n`;
		expect(mirroredBytes(`## Other\n\nx\n\n${section}## Machine\n`)).toBe(
			Buffer.byteLength(section),
		);
	});

	it("ends the section at an H1 as well", () => {
		const section = `## ${first}\n\nrule\n`;
		expect(mirroredBytes(`${section}# Appendix\n\nx\n`)).toBe(
			Buffer.byteLength(section),
		);
	});

	it("counts nothing under a heading the list does not name", () => {
		expect(mirroredBytes("## Other\n\nx\n### Removal means gone\n")).toBe(0);
	});
});
