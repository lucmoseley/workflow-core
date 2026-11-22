// @vitest-environment node

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertionOf, unresolvedCitations } from "./doc-map-assertions.js";

const CHECKER = path.resolve(__dirname, "../check-doc-map.js");
const TABLE = path.resolve(__dirname, "doc-map-assertions.js");

describe("doc-map assertion numbers", () => {
	it("reads single and listed citations in any case", () => {
		expect(
			unresolvedCitations([
				{
					file: "a.md",
					text: "(assertion 31); assertions 12 and 97; Assertion 27, 98, and 99",
				},
			]),
		).toEqual([
			{ file: "a.md", assertion: 97 },
			{ file: "a.md", assertion: 98 },
			{ file: "a.md", assertion: 99 },
		]);
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

	it("numbers exactly the finding tags check-doc-map.js reports", () => {
		const reported = [
			...readFileSync(CHECKER, "utf8").matchAll(/^\s*tag: "([A-Z-]+)",$/gm),
		]
			.map((m) => m[1] as string)
			.sort();
		const carried = [
			...readFileSync(TABLE, "utf8").matchAll(/"([A-Z][A-Z-]+)"/g),
		]
			.map((m) => m[1] as string)
			.sort();
		expect(carried).toEqual(reported);
		for (const tag of reported) expect(assertionOf(tag)).toBeGreaterThan(0);
	});

	it("refuses a tag no assertion carries", () => {
		expect(assertionOf("DEAD-ANCHOR")).toBe(28);
		expect(() => assertionOf("NO-SUCH-TAG")).toThrow(/names no assertion/);
	});
});
