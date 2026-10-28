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
 * ungated. Loosen isCollectedTestOrConftest and real code drops out of the
 * plugin, the needle corpus and doc-map's section-reference check; tighten it
 * and tests ship to adopters (#2759). Loosen siblingTests and a host guard
 * with no test passes the registry checks; tighten it and one tested by a
 * form the suite collects is refused as untested (#3170). Drift
 * .husky/pre-commit's test-file arms from JS_TEST_FILE and a commit staging
 * only a `.spec.` or `.mjs` test skips the gates that read it (#3170).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	COLLECTED_TEST,
	isCollectedTestOrConftest,
	isTestKind,
	JS_TEST_FILE,
	PY_COLLECTED_TEST,
	pytestSiblings,
	siblingTests,
	spellSiblingTests,
} from "./test-kind";

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

describe("isCollectedTestOrConftest", () => {
	it.each([
		"scripts/guard-x.test.ts",
		"scripts/foo.test.tsx",
		"scripts/foo.spec.ts",
		"scripts/test_evidence_corpus.py",
		"scripts/evidence_corpus_test.py",
		"scripts/foo.test.py",
		"scripts/conftest.py",
		"conftest.py",
		"foo.spec.js",
	])("calls %s a collected test or conftest.py", (rel) => {
		expect(isCollectedTestOrConftest(rel)).toBe(true);
	});

	it.each([
		"scripts/guard-x.sh",
		"scripts/check-test-marker.js",
		"scripts/evidence_test_support.py",
		"scripts/lib/git-fixture.ts",
		"scripts/lib-closure-fixture.ts",
		"scripts/my_conftest.py",
		".husky/pre-commit",
	])("calls %s neither", (rel) => {
		expect(isCollectedTestOrConftest(rel)).toBe(false);
	});
});

describe("siblingTests", () => {
	const tests = siblingTests("scripts/guard-c");

	it("names each form once, every one a test the suite collects", () => {
		expect(new Set(tests).size).toBe(tests.length);
		for (const t of tests)
			expect(JS_TEST_FILE.test(t) || PY_COLLECTED_TEST.test(t), t).toBe(true);
	});

	it("spells out every suffix JS_TEST_FILE takes, so a form added there reaches it", () => {
		const letters = ["", "c", "m", "j", "t", "x", "p", "s"];
		const exts = letters.flatMap((a) =>
			letters.flatMap((b) => letters.map((c) => `${a}${b}${c}s`)),
		);
		const candidates = ["test", "spec", "tests", "e2e"].flatMap((kind) =>
			[...exts, ...exts.map((e) => `${e}x`)].map(
				(ext) => `scripts/guard-c.${kind}.${ext}`,
			),
		);
		expect(tests.filter((t) => JS_TEST_FILE.test(t)).sort()).toEqual(
			[...new Set(candidates.filter((t) => JS_TEST_FILE.test(t)))].sort(),
		);
	});

	it.each([
		"scripts/guard-c.test.ts",
		"scripts/guard-c.test.js",
		"scripts/guard-c.test.mts",
		"scripts/guard-c.spec.js",
		"scripts/guard-c.spec.cjs",
		"scripts/test_guard-c.py",
		"scripts/guard-c_test.py",
		"scripts/guard-c.test.py",
	])("takes %s", (rel) => {
		expect(tests).toContain(rel);
	});

	it.each([
		"scripts/guard-c.sh",
		"scripts/guard-c.js",
		"scripts/guard-cx.test.ts",
		"scripts/lib/guard-c.test.ts",
		"scripts/guard-c.spec.py",
	])("leaves out %s", (rel) => {
		expect(tests).not.toContain(rel);
	});

	it("spells the forms for a refusal, the Python ones in the stem's directory", () => {
		expect(spellSiblingTests("scripts/guard-c")).toBe(
			"scripts/guard-c.{test,spec}.{,c,m}{j,t}s{,x}, scripts/test_guard-c.py, scripts/guard-c_test.py or scripts/guard-c.test.py",
		);
	});

	it("gives pytest's half by its default python_files", () => {
		expect(pytestSiblings("corpus")).toEqual([
			"test_corpus.py",
			"corpus_test.py",
		]);
	});
});

/* grep's ERE has no non-capturing group. */
const JS_TEST_ERE = JS_TEST_FILE.source.replaceAll("(?:", "(");

describe("JS_TEST_FILE in grep's ERE", () => {
	it("is JS_TEST_FILE to grep -E, path for path", () => {
		const paths = [
			...siblingTests("scripts/a"),
			"scripts/a.js",
			"scripts/a.test.tsy",
			"scripts/a.tests.ts",
			"scripts/a.test.ts.bak",
			"scripts/atest.ts",
		];
		let matched = "";
		try {
			matched = execFileSync("grep", ["-E", "-e", JS_TEST_ERE], {
				input: `${paths.join("\n")}\n`,
				encoding: "utf8",
			});
		} catch {
			/* grep exits 1 where nothing matches. */
		}
		expect(matched.split("\n").filter(Boolean)).toEqual(
			paths.filter((p) => JS_TEST_FILE.test(p)),
		);
	});

	it.each([
		"check-guard-test-isolation",
		"check-host-root-test-isolation",
		"check-git-fixture-identity",
	])(
		"opens .husky/pre-commit's %s gate on every test file vitest collects",
		(checker) => {
			const hook = fs.readFileSync(
				path.resolve(__dirname, "..", "..", ".husky", "pre-commit"),
				"utf8",
			);
			const arm = hook.match(
				new RegExp(
					String.raw`^if armed '([^']*)'; then\n\s*node \S*${checker}\.js`,
					"m",
				),
			)?.[1];
			expect(arm?.split("|^")[0]).toBe(`^scripts/.*${JS_TEST_ERE}`);
		},
	);
});
