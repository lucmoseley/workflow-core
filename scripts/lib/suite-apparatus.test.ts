// @vitest-environment node

import { describe, expect, it } from "vitest";
import { isApparatus } from "./suite-apparatus";

describe("isApparatus", () => {
	it.each([
		"scripts/a.test.ts",
		"scripts/lib/a.spec.mjs",
		"scripts/lib/gh-stub.ts",
		"scripts/fixtures/repo/x.js",
		"scripts/test_a.py",
		"vitest.config.ts",
		"vitest.setup.mts",
	])("calls %s apparatus", (rel) => {
		expect(isApparatus(rel)).toBe(true);
	});

	it("calls arm-gh-stub.js shipped code, a stub by name that build-arm-sandbox.js ships (#3743)", () => {
		expect(isApparatus("scripts/lib/arm-gh-stub.js")).toBe(false);
	});

	it.each([
		"scripts/check-host-root.js",
		"scripts/lib/vitest.config.helper.ts",
	])("calls %s shipped code", (rel) => {
		expect(isApparatus(rel)).toBe(false);
	});
});
