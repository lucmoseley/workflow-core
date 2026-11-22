// @vitest-environment node

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertionOf,
	citedAssertions,
	DOC_MAP_ASSERTIONS,
	unresolvedCitations,
} from "./doc-map-assertions.js";

const ROOT = path.resolve(__dirname, "../..");
const CHECKER = path.join(ROOT, "scripts/check-doc-map.js");

describe("doc-map assertion numbers", () => {
	it("reads single and listed citations", () => {
		expect(
			citedAssertions(
				"(assertion 31); assertions 12 and 13; Assertion 27, 28, and 29",
			),
		).toEqual([31, 12, 13, 27, 28, 29]);
	});

	it("names a cited number no assertion carries", () => {
		expect(
			unresolvedCitations({ "a.md": "assertion 3 and assertion 14" }),
		).toEqual(["a.md: assertion 3"]);
	});

	it("carries exactly the finding tags check-doc-map.js reports", () => {
		const reported = [
			...readFileSync(CHECKER, "utf8").matchAll(/^\s*tag: "([A-Z-]+)",$/gm),
		]
			.map((m) => m[1])
			.sort();
		const carried = Object.values(DOC_MAP_ASSERTIONS)
			.flatMap((a) => a.tags)
			.sort();
		expect(carried).toEqual(reported);
	});

	it("refuses a tag no assertion carries", () => {
		expect(assertionOf("DEAD-ANCHOR")).toBe(28);
		expect(() => assertionOf("NO-SUCH-TAG")).toThrow(/names no assertion/);
	});
});
