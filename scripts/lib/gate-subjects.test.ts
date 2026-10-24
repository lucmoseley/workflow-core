// @vitest-environment node
/*
 * gate-subjects.js finds each gate's subject in a repo's index (#1506).
 * check-gate-switches.js refuses a commit on what it finds and init-adopter.js
 * switches modules on by it, so a shape it misses is a gate that never binds.
 * The module reads the index, so each case stages files in a real scratch
 * repo rather than writing them alone.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { subjectModules, subjectsInIndex } from "./gate-subjects.js";
import { mkScratchDir } from "./git-fixture";

let dir: string;

/** Writes and stages each file, its body `x` unless one is given. */
const track = (files: Record<string, string> | string[]) => {
	const entries = Array.isArray(files)
		? files.map((f) => [f, "x\n"])
		: Object.entries(files);
	for (const [file, body] of entries) {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), body);
	}
	execFileSync("git", ["add", "--", ...entries.map(([f]) => f)], { cwd: dir });
};

const subjects = () => subjectsInIndex(dir).map((s) => s.subject);

beforeEach(() => {
	dir = mkScratchDir("gate-subjects-");
	execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: dir });
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const SECTION_B = "## Section B — registry\n\n### B1 · A figure\n\nBody.\n";

describe("subjectsInIndex", () => {
	it("finds nothing in an empty index", () => {
		expect(subjectsInIndex(dir)).toEqual([]);
	});

	it.each([
		"a.test.js",
		"lib/a.test.mjs",
		"lib/a.test.cjs",
		"src/a.test.ts",
		"src/A.test.tsx",
		"src/A.test.jsx",
		"src/a.test.mts",
		"test_a.py",
		"pkg/a_test.py",
		"test/a.test.py",
		"src/a.spec.ts",
	])("reads %s as a test file", (file) => {
		track([file]);
		expect(subjectsInIndex(dir)).toEqual([
			{ subject: "tests", module: "suites", found: [file] },
		]);
	});

	it.each(["a.test.md", "testing.py", "a.spec.md", "contest_a.py"])(
		"reads %s as no test file",
		(file) => {
			track([file]);
			expect(subjects()).toEqual([]);
		},
	);

	it("reads a test file that is on disk but untracked as no subject", () => {
		fs.writeFileSync(path.join(dir, "a.test.js"), "x\n");
		expect(subjects()).toEqual([]);
	});

	it("finds the roadmap by its exact path only", () => {
		track(["vendor/docs/reference-roadmap.html"]);
		expect(subjects()).toEqual([]);
		track(["docs/reference-roadmap.html"]);
		expect(subjects()).toEqual(["roadmap"]);
	});

	it("finds governance by the manual", () => {
		track(["docs/operating-manual.md"]);
		expect(subjects()).toEqual(["governance"]);
	});

	it("finds governance by a §B entry in the doc map's staged blob, not its working copy", () => {
		track({ "docs/doc-map.md": "## Section B — registry\n\nNone yet.\n" });
		fs.writeFileSync(path.join(dir, "docs/doc-map.md"), SECTION_B);
		expect(subjects()).toEqual([]);
		track({ "docs/doc-map.md": SECTION_B });
		expect(subjects()).toEqual(["governance"]);
	});

	it("finds the site only where the brand sheet and app/ are both tracked", () => {
		track(["app/page.tsx"]);
		expect(subjects()).toEqual([]);
		track(["docs/brand-sheet.md"]);
		expect(subjects()).toEqual(["site"]);
	});

	it("reads the brand sheet at the root's declared brandSheetPath", () => {
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(
			path.join(dir, ".claude/workflow-core.json"),
			JSON.stringify({
				contract: 1,
				founder: "T",
				brandSheetPath: "docs/brand/sheet.md",
			}),
		);
		track(["app/page.tsx", "docs/brand-sheet.md"]);
		expect(subjects()).toEqual([]);
		track(["docs/brand/sheet.md"]);
		expect(subjects()).toEqual(["site"]);
	});

	it("throws where git cannot list the index", () => {
		expect(() => subjectsInIndex(path.join(dir, "nowhere"))).toThrow(
			/git ls-files/,
		);
	});
});

describe("subjectModules", () => {
	it("names each found subject's module", () => {
		track({
			"a.test.js": "x\n",
			"docs/reference-roadmap.html": "x\n",
			"docs/operating-manual.md": "x\n",
			"docs/brand-sheet.md": "x\n",
			"app/page.tsx": "x\n",
		});
		expect(subjectModules(dir)).toEqual([
			"suites",
			"roadmap",
			"governance",
			"site",
		]);
	});
});
