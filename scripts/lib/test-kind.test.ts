// @vitest-environment node
/*
 * Pins each limb of the test-kind reading the standards checker, the
 * architecture-scan counter and the test-rules injector share (#1743, #2101),
 * and of the narrower COLLECTED_TEST gate-subjects.js reads. A table of paths fed straight to
 * the predicate, since it reads no file. Loosen it and the checker counts a
 * test as a real consumer while the counter counts test support as growth;
 * tighten it and real code drops out of both. Loosen COLLECTED_TEST and a repo
 * holding only test support counts as holding a suite, so its commits are
 * refused while the suites switch is off; tighten it and a real suite goes
 * ungated.
 */

import { describe, expect, it } from "vitest";
import { COLLECTED_TEST, isTestKind } from "./test-kind";

describe("isTestKind", () => {
	it.each([
		"scripts/a.test.ts",
		"app/b.test.tsx",
		"c.test.js",
		"c.test.mjs",
		"c.test.cjs",
		"c.test.jsx",
		"c.test.mts",
		"a.spec.ts",
		"app/b.spec.tsx",
		"c.spec.js",
		"c.spec.cjs",
		"c.spec.mjs",
		"c.spec.jsx",
		"c.spec.mts",
		"test/helper.js",
		"scripts/tests/helper.js",
		"scripts/lib/fixtures/probe.js",
		"testkits/x.js",
		"lib/stubs/gh.js",
		"lib/fakes/clock.ts",
		"scripts/lib/thing-testkit.ts",
		"scripts/lib/run.harness.js",
		"lib/fake-gh.js",
		"lib/stub.ts",
		"py/test_d.py",
		"py/e_test.py",
		"py/conftest.py",
	])("calls %s test kind", (rel) => {
		expect(isTestKind(rel)).toBe(true);
	});

	it.each([
		"scripts/check-code-standards.js",
		"scripts/lib/latest.js",
		"scripts/contest.js",
		"py/testing_utils.py",
		"lib/stubborn.js",
		"docs/test-read-edges.json",
		"docs/spec.md",
		"lib/inspect.ts",
	])("calls %s code", (rel) => {
		expect(isTestKind(rel)).toBe(false);
	});
});

describe("COLLECTED_TEST", () => {
	it.each([
		"a.test.js",
		"app/A.test.jsx",
		"lib/a.test.mts",
		"lib/a.test.cts",
		"src/a.test.tsx",
		"py/test_d.py",
		"py/e_test.py",
		"test/a.test.py",
		"a.spec.ts",
		"app/A.spec.jsx",
	])("calls %s a collected test", (rel) => {
		expect(COLLECTED_TEST.test(rel)).toBe(true);
	});

	it.each([
		"tests/helper.ts",
		"scripts/lib/thing-testkit.ts",
		"py/conftest.py",
		"a.test.md",
		"docs/spec.md",
	])("calls %s no collected test", (rel) => {
		expect(COLLECTED_TEST.test(rel)).toBe(false);
	});
});
