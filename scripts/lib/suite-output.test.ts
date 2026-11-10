// @vitest-environment node
/*
 * lib/suite-output.js's reading of a vitest or pytest run's output (#3937).
 *
 * Loosen it and a red names the wrong test, one failure reads as two across
 * runs, or two offenders read as one, so a bisect blames the wrong commit.
 */
import { describe, expect, it } from "vitest";
import { parseFailingTests } from "./suite-output.js";

it("names the failing tests vitest and pytest print, each with its error's first line (#3937)", () => {
	expect(
		parseFailingTests(
			[
				" \u001b[31mFAIL\u001b[39m  scripts/a.test.ts > suite > it",
				" FAIL  scripts/a.test.ts > suite > other",
				"",
				"AssertionError: expected 1 to be 2",
				" FAIL  scripts/b.test.ts [ scripts/b.test.ts ]",
				"Error: Failed to load",
				" FAIL  scripts/c.test.ts > suite > it",
				"FAILED scripts/test_d.py::test_x - AssertionError: no",
				"FAILED scripts/test_d.py::test_y",
				"ERROR scripts/test_e.py - ImportError",
			].join("\n"),
		),
	).toEqual([
		{
			file: "scripts/a.test.ts",
			test: "suite > it",
			message: "AssertionError: expected 1 to be 2",
			signature: expect.any(String),
		},
		{
			file: "scripts/a.test.ts",
			test: "suite > other",
			message: "AssertionError: expected 1 to be 2",
			signature: expect.any(String),
		},
		{
			file: "scripts/b.test.ts",
			test: "[ scripts/b.test.ts ]",
			message: "Error: Failed to load",
			signature: expect.any(String),
		},
		{ file: "scripts/c.test.ts", test: "suite > it" },
		{
			file: "scripts/test_d.py",
			test: "test_x",
			message: "AssertionError: no",
			signature: expect.any(String),
		},
		{ file: "scripts/test_d.py", test: "test_y" },
	]);
});

describe("a failure's signature (#3937)", () => {
	/* Vitest's print of `toEqual([])` on a list of one offender, as run on #3937. */
	const scanRed = (offender: string) =>
		parseFailingTests(
			[
				" FAIL  scripts/lib/script-path-scan.test.ts > messages > name no script",
				"AssertionError: expected [ Array(1) ] to deeply equal []",
				"",
				"- Expected",
				"+ Received",
				"",
				"- []",
				"+ [",
				`+   "${offender}",`,
				"+ ]",
				"",
				" ❯ scripts/lib/script-path-scan.test.ts:78:4",
				"    76|   expect(",
			].join("\n"),
		)[0];
	const signed = (message: string) =>
		parseFailingTests(`FAILED scripts/test_a.py::test_x - ${message}`)[0]
			?.signature;

	it("tells the ticket's two offenders in one test apart, and shows the one found", () => {
		const first = scanRed("lib/review-findings.js:75");
		expect(first?.message).toBe(
			'AssertionError: expected [ Array(1) ] to deeply equal [] / - [] / + [ / +   "lib/review-findings.js:75", / + ]',
		);
		expect(first?.signature).not.toBe(
			scanRed("lib/pull-form.js:205")?.signature,
		);
	});

	it.each([
		["a moved line", "at lib/a.js:75", "at lib/a.js:79"],
		["a sha", "red at 4fbccfa99", "red at 8caad354d"],
		["a checkout's path", "/home/runner/w/lib/a.js", "/home/lucmo/lib/a.js"],
	])("is one across a difference only in %s", (_, was, now) => {
		expect(signed(was)).toBe(signed(now));
	});

	it("is one across paths whose lengths would cut a long message differently", () => {
		const tail = "x ".repeat(400);
		expect(signed(`/home/runner/work/lib/a.js ${tail}1`)).toBe(
			signed(`/h/lib/a.js ${tail}1`),
		);
		expect(signed(`/h/lib/a.js ${tail}one`)).not.toBe(
			signed(`/h/lib/a.js ${tail}two`),
		);
	});

	it("takes no runner progress line as a test's error", () => {
		expect(
			parseFailingTests(
				" FAIL  scripts/a.test.ts > it\n ✓ scripts/c.test.ts (3 tests)",
			),
		).toEqual([{ file: "scripts/a.test.ts", test: "it" }]);
	});
});
