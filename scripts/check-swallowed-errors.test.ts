// @vitest-environment node

/*
 * Pins check-swallowed-errors.js in an adopter-shaped repo: what it charges,
 * which citations pass, and which paths it judges (#1830).
 *
 * It is the pre-commit swallowed-error gate's judge in every repo: loosen a
 * case and an uncited swallow lands unrefused, or a commit is refused for
 * swallows it inherited or for a test file. What counts as a swallow and a
 * citation is swallowed_errors.py's, pinned by test_swallowed_errors.py.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	registerTempCleanup,
	stagedRepo,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import { ROOT } from "./lib/precommit-gate-testkit";
import { writeHostConfig } from "./lib/ruff-testkit";
import { runInProcess } from "./lib/run-in-process.js";

const temps = registerTempCleanup();
const CHECKER = path.join(ROOT, "scripts", "check-swallowed-errors.js");
const WAY_OUT =
	/says why at the site and cites the ticket that chose it, or raises or exits/;

const PY = "tools/fetch.py";
const ROUTES = { "tools/test_*.py": "test", "tools/**/*.py": "program" };
const swallow = (comment = "", fn = "fetch") =>
	`def ${fn}():\n    try:\n        return 1\n    except OSError:\n        return None${comment}\n`;

/** An adopter repo holding `committed` at HEAD and `staged` in the index. */
function repo(
	committed: Record<string, string>,
	staged: Record<string, string>,
	pythonRoutes: object | undefined = ROUTES,
): TempRepo {
	const r = stagedRepo("swallowed-errors-", temps, committed, staged);
	writeHostConfig(r.root, { tracker: "acme/widgets", pythonRoutes });
	return r;
}

function check(r: TempRepo, args: string[] = []) {
	const run = runInProcess(CHECKER, args, {
		cwd: r.root,
		// Pinned, never inherited: the session's own CLAUDE_PROJECT_DIR would
		// read this repo's config rather than the fixture's.
		env: { ...process.env, CLAUDE_PROJECT_DIR: r.root },
	});
	return { code: run.status, output: `${run.stdout}${run.stderr}` };
}

describe("check-swallowed-errors in an adopter", () => {
	it("refuses a narrow except that swallows and cites no ticket, naming it and the way out", () => {
		const { code, output } = check(repo({}, { [PY]: swallow() }));
		expect(output).toMatch(/tools\/fetch\.py: `except OSError` in fetch/);
		expect(output).toMatch(/tools\/fetch\.py:4/);
		expect(output).toMatch(WAY_OUT);
		expect(code).toBe(1);
	});

	it("passes one citing the host's own #N, or a corpus repo's", () => {
		for (const cite of ["  # unreachable host (#12)", "  # widgets#12"]) {
			const { code, output } = check(repo({}, { [PY]: swallow(cite) }));
			expect(output).toMatch(/no uncited swallow introduced across 1/);
			expect(code).toBe(0);
		}
	});

	it("refuses one citing a tracker outside the corpus", () => {
		const { code, output } = check(
			repo({}, { [PY]: swallow("  # gadgets#12") }),
		);
		expect(output).toMatch(WAY_OUT);
		expect(code).toBe(1);
	});

	it("passes a swallow HEAD already had, moved down by an added line", () => {
		const r = repo({ [PY]: swallow() }, { [PY]: `import os\n${swallow()}` });
		const { code, output } = check(r);
		expect(output).toMatch(/no uncited swallow introduced across 1/);
		expect(code).toBe(0);
	});

	it("charges a second uncited swallow in a function that had one", () => {
		const twice = swallow().replace(
			"        return None\n",
			"        return None\n    try:\n        pass\n    except OSError:\n        pass\n",
		);
		const { code, output } = check(repo({ [PY]: swallow() }, { [PY]: twice }));
		expect(output).toMatch(/1 of these 2 were already in HEAD/);
		expect(code).toBe(1);
	});

	it("judges no path a declared row routes to test", () => {
		const { code, output } = check(
			repo({}, { "tools/test_fetch.py": swallow() }),
		);
		expect(output).toMatch(/no program-routed Python path to judge/);
		expect(code).toBe(0);
	});

	it("with no row, judges a shebang file outside test/ and nothing else, as base §0's default map does", () => {
		const shebang = `#!/usr/bin/env python3\n${swallow()}`;
		const r = repo(
			{},
			{ "a.py": swallow(), "bin/b.py": shebang, "test/c.py": shebang },
			undefined,
		);
		const { code, output } = check(r);
		expect(output).toMatch(/bin\/b\.py: `except OSError`/);
		expect(output).not.toMatch(/a\.py:|test\/c\.py/);
		expect(code).toBe(1);
	});

	it("with --all, charges every swallow in the worktree, HEAD's included", () => {
		const r = repo({ [PY]: swallow(), "tools/b.py": swallow("", "b") }, {});
		const { code, output } = check(r, ["--all"]);
		expect(output).toMatch(/FAIL: 2 uncited swallow/);
		expect(code).toBe(1);
	});
});
