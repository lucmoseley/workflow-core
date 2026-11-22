// @vitest-environment node

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertionOf, unresolvedCitations } from "./doc-map-assertions.js";

const CHECKER = path.resolve(__dirname, "../check-doc-map.js");

describe("doc-map assertion numbers", () => {
	it("resolves single and listed citations of carried numbers", () => {
		expect(
			unresolvedCitations([
				{
					file: "a.md",
					text: "(assertion 31); assertions 12 and 13; Assertion 27, 28, and 29",
				},
			]),
		).toEqual([]);
	});

	it("names each cited number no assertion carries, a listed one included", () => {
		expect(
			unresolvedCitations([
				{ file: "a.md", text: "assertion 3 and assertion 14" },
				{ file: "b.md", text: "assertions 12, 99 and 13" },
			]),
		).toEqual([
			{ file: "a.md", assertion: 3 },
			{ file: "b.md", assertion: 99 },
		]);
	});

	it("numbers every finding tag check-doc-map.js reports", () => {
		const reported = [
			...readFileSync(CHECKER, "utf8").matchAll(/^\s*tag: "([A-Z-]+)",$/gm),
		].map((m) => m[1] as string);
		expect(reported.length).toBeGreaterThan(40);
		for (const tag of reported) expect(assertionOf(tag)).toBeGreaterThan(0);
	});

	it("refuses a tag no assertion carries", () => {
		expect(assertionOf("DEAD-ANCHOR")).toBe(28);
		expect(() => assertionOf("NO-SUCH-TAG")).toThrow(/names no assertion/);
	});
});
