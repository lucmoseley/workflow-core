// @vitest-environment node
/*
 * Pins which tracked files count as the suite, the WARN-never-gate drift
 * verdict against the ladder's baseline, and the BROKEN verdict when git,
 * vitest's listing or the baseline fails.
 *
 * check-suite-size-drift.js counts the tracked test files vitest would collect
 * and compares that against the count the memory ladder was measured on, so a
 * throwaway git repo holding empty files is the fixture for every case but the
 * real-repo block, which reads the live baseline.
 *
 * What it protects against is silent: the 1/2/3-suite headroom ladder in
 * `docs/environment.md` is derived from a dip measured on a suite of a
 * particular size, and a suite that outgrows it makes the ladder wrong with
 * nothing else having changed (mantahostels#954).
 *
 * It runs in `npm run status` and the daily repo-checks run: loosen a case and a grown suite stops
 * prompting a re-measure, so sessions keep admitting concurrent suites on
 * headroom that no longer holds and the machine freezes under `earlyoom`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate, mkScratchDir } from "./lib/git-fixture";

const SCRIPT = path.resolve(__dirname, "check-suite-size-drift.js");
const REPO = path.resolve(__dirname, "..");

let dir: string;

/** git in the fixture repo. */
const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" });

/** THE FIXTURE IS BUILT ONCE AND COPIED (mantahostels#2068), via scripts/lib/git-fixture.ts. */
const buildTemplate = (root: string) => {
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
	execFileSync("git", ["config", "user.name", "t"], { cwd: root });
};

const template = defineTemplate(buildTemplate);

/** Track `n` files matching vitest's include, under `prefix`. */
const addTests = (n: number, prefix = "lib") => {
	fs.mkdirSync(path.join(dir, prefix), { recursive: true });
	for (let i = 0; i < n; i++) {
		const p = path.join(prefix, `f${i}.test.ts`);
		fs.writeFileSync(path.join(dir, p), "");
		git("add", "--", p);
	}
};

/** Track one path verbatim, so include/exclude can be exercised by name. */
const track = (p: string) => {
	fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
	fs.writeFileSync(path.join(dir, p), "");
	git("add", "--", p);
};

/** Run the checker in `where` (the fixture repo by default), streams apart. */
const runIn = (where: string, ...args: string[]) => {
	const r = spawnSync("node", [SCRIPT, ...args], {
		cwd: where,
		encoding: "utf8",
		env: { ...process.env, CLAUDE_PROJECT_DIR: where },
	});
	return {
		status: r.status ?? -1,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
		out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
		json: () => JSON.parse(r.stdout),
	};
};

const run = (...args: string[]) => runIn(dir, ...args);

beforeEach(() => {
	dir = mkScratchDir("suite-size-drift-");
	template.instantiate(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("counting what vitest would collect", () => {
	it("counts .test and .spec across the js/ts extensions", () => {
		track("a.test.ts");
		track("b.spec.tsx");
		track("c.test.mjs");
		track("d.spec.cjs");
		track("e.test.js");
		const r = run("--json", "--baseline", "5");
		expect(r.json().files).toBe(5);
	});

	it("counts a test file under a dot-directory, which vitest's include reaches", () => {
		track(".claude/skills/x/y.test.ts");
		const r = run("--json", "--baseline", "1");
		expect(r.json().files).toBe(1);
	});

	it("excludes what the repo's own vitest config excludes", () => {
		track("real.test.ts");
		track(".claude/worktrees/w/real.test.ts");
		fs.writeFileSync(
			path.join(dir, "vitest.config.mjs"),
			'export default { test: { exclude: [".claude/worktrees/**"] } };\n',
		);
		fs.symlinkSync(
			path.join(REPO, "node_modules"),
			path.join(dir, "node_modules"),
		);
		const r = run("--json", "--baseline", "1");
		expect(r.json().files).toBe(1);
	});

	it("ignores a source file that merely has 'test' in its name", () => {
		track("testing.ts");
		track("lib/test-helpers.ts");
		const r = run("--json", "--baseline", "1");
		expect(r.json().files).toBe(0);
	});

	it("counts only tracked files", () => {
		track("tracked.test.ts");
		fs.writeFileSync(path.join(dir, "untracked.test.ts"), "");
		const r = run("--json", "--baseline", "1");
		expect(r.json().files).toBe(1);
	});
});

describe("the drift verdict (mantahostels#954, the ladder that outgrew its measurement)", () => {
	it("is OK when the suite is the size the ladder was measured on", () => {
		addTests(10);
		const r = run("--baseline", "10");
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK");
	});

	it("is OK inside the threshold", () => {
		addTests(12); // +20% against 10
		const r = run("--baseline", "10", "--threshold", "25");
		expect(r.out).toContain("OK");
	});

	it("WARNs once growth passes the threshold, giving the growth as a percentage", () => {
		addTests(13); // +30% against 10
		const r = run("--baseline", "10", "--threshold", "25");
		expect(r.out).toContain("WARN");
		expect(r.out).toMatch(/\+30%/);
	});

	it("WARNs on shrinkage too, which makes the ladder needlessly strict, giving the shrinkage as a percentage", () => {
		addTests(7); // -30% against 10
		const r = run("--baseline", "10", "--threshold", "25");
		expect(r.out).toContain("WARN");
		expect(r.out).toMatch(/-30%/);
	});

	it("never gates — a drifted suite exits 0", () => {
		addTests(100);
		expect(run("--baseline", "10").status).toBe(0);
	});

	it("names the ladder's owner document", () => {
		addTests(100);
		expect(run("--baseline", "10").out).toContain("docs/environment.md");
	});

	it("names the harness that re-measures", () => {
		addTests(100);
		expect(run("--baseline", "10").out).toContain(
			"scripts/bench_suite_concurrency.py",
		);
	});
});

describe("the copied fixture is isolated from its template (mantahostels#2068)", () => {
	it("a write made in the copy leaves the template untouched", () => {
		track("only-in-copy.test.ts");
		expect(run("--json", "--baseline", "1").json().files).toBe(1);

		const fresh = mkScratchDir("suite-size-drift-");
		template.instantiate(fresh);
		try {
			expect(runIn(fresh, "--json", "--baseline", "1").json().files).toBe(0);
		} finally {
			fs.rmSync(fresh, { recursive: true, force: true });
		}
	});
});

describe("apparatus failures", () => {
	it("is BROKEN outside a git repo, naming git as the apparatus that failed", () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
		const r = runIn(outside, "--baseline", "10");
		fs.rmSync(outside, { recursive: true, force: true });
		expect(r.status).toBe(2);
		expect(r.out).toContain("git rev-parse");
		expect(r.out).toContain("No suite counted");
	});

	it("is BROKEN where a vitest config is present but vitest will not list", () => {
		track("a.test.ts");
		fs.writeFileSync(
			path.join(dir, "vitest.config.mjs"),
			"export default {};\n",
		);
		const r = run("--baseline", "1");
		expect(r.status).toBe(2);
		expect(r.out).toContain("vitest list failed");
		expect(r.out).toContain("No suite counted");
	});

	it("is BROKEN on a baseline that is not a positive number, and says which flag", () => {
		addTests(1);
		for (const bad of ["nonsense", "0"]) {
			const r = run("--baseline", bad);
			expect(r.status).toBe(2);
			expect(r.out).toContain("--baseline");
			expect(r.out).toContain("usage:");
		}
	});
});

describe("the real repo", () => {
	it("reads its baseline from the ladder's own module", () => {
		const src = fs.readFileSync(
			path.resolve(__dirname, "check-suite-size-drift.js"),
			"utf8",
		);
		expect(src).toContain("./lib/admission");
	});

	it("counts the live suite and agrees with the baseline recorded beside the ladder", () => {
		const { SUITE_LADDER_MEASURED_AT } = require("./lib/admission.js");
		expect(SUITE_LADDER_MEASURED_AT.files).toBeGreaterThan(0);
		const r = runIn(REPO, "--json");
		expect(r.json().baseline).toBe(SUITE_LADDER_MEASURED_AT.files);
	});

	it("counts the same suite from a subdirectory, since the hook's siblings run from the repo root", () => {
		const fromRoot = runIn(REPO, "--json").json().files;
		const fromSub = runIn(path.join(REPO, "docs"), "--json").json().files;
		expect(fromSub).toBe(fromRoot);
	});
});

/*
 * --notify is lib/check.js's SessionStart-hook mode: it moves the report to
 * stdout and swallows the exit code. This checker runs from `npm run status`,
 * not a hook, but keeps the mode working. Both are `lib/check.js` contracts
 * rather than this checker's, so a fix goes there.
 */
describe("the --notify contract a SessionStart hook would rest on", () => {
	it("puts a drift report on stdout, where a SessionStart hook can read it", () => {
		addTests(100);
		const r = run("--baseline", "10", "--notify");
		expect(r.stdout).toContain("WARN");
		expect(r.stderr).toBe("");
	});

	it("says nothing at all when the suite has not drifted", () => {
		addTests(10);
		const r = run("--baseline", "10", "--notify");
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe("");
	});

	it("exits 0 even when it is BROKEN, so the hook is not switched off", () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
		const r = runIn(outside, "--baseline", "10", "--notify");
		fs.rmSync(outside, { recursive: true, force: true });
		expect(r.status).toBe(0);
	});
});
