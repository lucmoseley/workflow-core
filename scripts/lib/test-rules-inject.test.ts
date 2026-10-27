// @vitest-environment node
/*
 * lib/test-rules-inject.js hands a session base §X8, §X9 and §X10 the first
 * time it writes a test file (#1887, spec #1869). Break it and a session
 * writes a slow or unselectable test with the rules it breaks never in front
 * of it.
 *
 * Module cases on the core, its path read by the real repo-relative spelling over a temp
 * checkout; the latch, the cap and its deferral are lib/guard-entry.test.ts's,
 * the symlinked spelling of a path lib/guard-dispatch.test.ts's.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COLLECTED_TEST, isTestKind } from "./test-kind.js";

const { decide } = require("./test-rules-inject.js") as {
	decide: (
		file: string,
		ctx: { repoRel: (file: string) => string | null },
	) => unknown;
};
const { repoRel } = require("./guard-dispatch.js") as {
	repoRel: (file: string, root: string) => string | null;
};

let dir: string;
let repo: string;

beforeAll(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-rules-")));
	repo = path.join(dir, "repo");
	fs.mkdirSync(repo);
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const judged = (file: string) =>
	decide(`${repo}/${file}`, { repoRel: (f) => repoRel(f, repo) });

const RULES = {
	injectRules: ["test-run-cost", "test-time-seam", "test-reads-visible"],
};

describe("a test-file write", () => {
	it("is handed §X8, §X9 and §X10, in that order", () => {
		expect(judged("scripts/foo.test.ts")).toEqual(RULES);
	});

	// isTestKind imported, so an edit to the predicate selects this file.
	it.each([
		"app/a.test.jsx",
		"scripts/test_foo.py",
		"lib/fixtures/data.json",
		"lib/stubs/gh.js",
		"lib/fake-clock.js",
		"scripts/lib/run-harness.js",
		"pkg/a.test.py",
		"src/a.spec.ts",
	])(
		"is handed them on %s, a path base §X binds or a runner collects (#2101, #2109)",
		(file) => {
			expect(isTestKind(file) || COLLECTED_TEST.test(file)).toBe(true);
			expect(judged(file)).toEqual(RULES);
		},
	);

	it("is handed them on a mid-path `..` that stays inside the checkout (#2546)", () => {
		expect(judged("sub/../tests/a.ts")).toEqual(RULES);
	});
});

describe("any other write", () => {
	it.each([
		"docs/notes.md",
		"x.ipynb",
		"docs/latest.md",
		"scripts/stubborn.js",
		"lib/inspect.ts",
	])("is handed nothing on %s, a path the shared predicate refuses", (file) => {
		expect(judged(file)).toBeNull();
	});

	// Under a `tests/` the predicate would match, the path as the harness may
	// send it, `..` unresolved, leading or mid-path.
	it.each(["../tests/notes.md", "sub/../../tests/a.ts"])(
		"is handed nothing on %s, a write outside the checkout (#2101, #2546)",
		(file) => {
			expect(judged(file)).toBeNull();
		},
	);
});
