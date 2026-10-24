// @vitest-environment node

/*
 * Pins that check-ruff-introduced.js refuses only the ruff findings a commit
 * introduces, keyed by code and message rather than line, and honours the
 * adopter's `ruffExclude`.
 *
 * check-ruff-introduced.js (#122), run as the pre-commit hook runs it: a child
 * `node` process in a throwaway repo, its ruff injected at WFC_RUFF.
 *
 * ruff is lib/ruff-testkit.ts's stub, so each case places its own findings;
 * the `with the real ruff` cases pin what the stub cannot know — that ruff's
 * own messages carry line numbers, and that --force-exclude reaches a stdin
 * path. The hook's shell around this checker is
 * scripts/precommit-ruff-gate.test.ts's.
 *
 * It is the Python gate in .husky/pre-commit: loosen a case and new findings
 * land, or a commit is charged for findings the file already had, leaving
 * files nobody can touch.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	registerTempCleanup,
	stagedRepo,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import { ROOT } from "./lib/precommit-gate-testkit";
import {
	PLUGIN_SELECT,
	REAL_RUFF,
	stubCalls,
	writeHostConfig,
	writeRuffStub,
} from "./lib/ruff-testkit";

const temps = registerTempCleanup();
const CHECKER = path.join(ROOT, "scripts", "check-ruff-introduced.js");
const ARGS_FILE = "ruff-args.txt";

const PY = "pkg/thing.py";
const BODY = "print(1)\n";
const OLD = "# FINDING F401 `os` imported but unused\n";
const NEW = "# FINDING F821 Undefined name `x`\n";

const repo = (
	committed: Record<string, string>,
	staged: Record<string, string>,
) => stagedRepo("ruff-introduced-", temps, committed, staged);

/**
 * The checker run in `r`, against a fresh ruff stub exiting `ruffExit` (0 when
 * absent) unless `ruff` names one.
 */
function check(
	r: TempRepo,
	opts: { ruff?: string; ruffExit?: number; args?: string[] } = {},
): { code: number; output: string; calls: string[][] } {
	let ruff = opts.ruff;
	if (!ruff) {
		ruff = path.join(r.root, "..", `${path.basename(r.root)}-ruff`);
		temps.push(ruff);
		writeRuffStub(ruff, path.join(r.root, ARGS_FILE), opts.ruffExit);
	}
	const run = spawnSync(process.execPath, [CHECKER, ...(opts.args ?? [])], {
		cwd: r.root,
		encoding: "utf8",
		// Pinned, never inherited: the session's own CLAUDE_PROJECT_DIR would
		// read this repo's config rather than the fixture's.
		env: { ...process.env, WFC_RUFF: ruff, CLAUDE_PROJECT_DIR: r.root },
	});
	const code = run.status ?? 1;
	const output = `${run.stdout}${run.stderr}`;
	return { code, output, calls: stubCalls(path.join(r.root, ARGS_FILE)) };
}

/** The value following each occurrence of `flag`, across every call. */
const valuesOf = (calls: string[][], flag: string) =>
	calls.flatMap((argv) =>
		argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : [])),
	);

describe("check-ruff-introduced", () => {
	it("is OK, running no ruff, when no Python path is staged", () => {
		const r = repo({}, { "notes.md": "# x\n" });
		const { code, output, calls } = check(r);
		expect(calls).toEqual([]);
		expect(output).toMatch(/OK: no staged Python path/);
		expect(code).toBe(0);
	});

	it("passes a finding the file already had, moved down by an added line", () => {
		const r = repo(
			{ [PY]: `${OLD}${BODY}` },
			{ [PY]: `# more\n${OLD}${BODY}` },
		);
		const { code, output } = check(r);
		expect(output).toMatch(/no ruff finding introduced across 1 Python path/);
		expect(code).toBe(0);
	});

	it("refuses a finding the commit introduces, naming it and where it is", () => {
		const r = repo({ [PY]: `${OLD}${BODY}` }, { [PY]: `${OLD}${NEW}${BODY}` });
		const { code, output } = check(r);
		expect(output).toMatch(/pkg\/thing\.py: F821 Undefined name `x`/);
		expect(output).toMatch(/pkg\/thing\.py:2:1/);
		expect(output).not.toMatch(/F401/);
		expect(code).toBe(1);
	});

	it("charges a second copy of a finding the file already had once", () => {
		// Keyed by count as well as by code and message: a set comparison would
		// wave the second one through as already present.
		const r = repo({ [PY]: `${NEW}${BODY}` }, { [PY]: `${NEW}${NEW}${BODY}` });
		const { code, output } = check(r);
		expect(output).toMatch(/1 of these 2 were already in HEAD/);
		expect(code).toBe(1);
	});

	it("charges every finding in a file HEAD does not have", () => {
		const r = repo({}, { [PY]: `${OLD}${BODY}` });
		const { code, output } = check(r);
		expect(output).toMatch(/F401/);
		expect(code).toBe(1);
	});

	it("reads a message's `line <n>` as no part of the finding", () => {
		// F811's message names the line it shadows, so a line added above it
		// rewrites the message — a key holding the number charges that as new.
		const r = repo(
			{ [PY]: "# FINDING F811 Redefinition of unused `os` from line 1\n" },
			{ [PY]: "# FINDING F811 Redefinition of unused `os` from line 2\n" },
		);
		expect(check(r).code).toBe(0);
	});

	it("judges a renamed file against its source's findings", () => {
		// `git diff --cached --name-only` names the new path alone, whose HEAD
		// blob does not exist — without the rename lookup a `git mv` charges
		// every finding the file carried.
		const r = repo({ [PY]: `${OLD}${BODY}` }, {});
		r.git("mv", "--", PY, "pkg/moved.py");
		const { code, calls } = check(r);
		expect(valuesOf(calls, "--stdin-filename")).toContain("pkg/moved.py");
		expect(code).toBe(0);
	});

	it("judges the STAGED blob, whatever the worktree holds", () => {
		// The commit carries the index, so a finding fixed on disk but not
		// staged is still committed — and one deleted from disk is still judged.
		const fixed = repo({}, { [PY]: `${NEW}${BODY}` });
		fs.writeFileSync(path.join(fixed.root, PY), BODY);
		expect(check(fixed).code).toBe(1);

		const gone = repo({}, { [PY]: `${NEW}${BODY}` });
		fs.rmSync(path.join(gone.root, PY));
		expect(check(gone).code).toBe(1);
	});

	it("keeps a path holding a space whole", () => {
		const spaced = "pkg/with space.py";
		const r = repo({}, { [spaced]: BODY });
		const { code, calls } = check(r);
		expect(valuesOf(calls, "--stdin-filename")).toEqual([spaced]);
		expect(code).toBe(0);
	});

	it("judges only the staged .py paths, and not a staged deletion", () => {
		const r = repo(
			{ "pkg/gone.py": `# gone\n${"# distinct\n".repeat(12)}` },
			{
				[PY]: BODY,
				"pkg/other.js": "1;\n",
			},
		);
		r.git("rm", "-q", "--", "pkg/gone.py");
		expect(valuesOf(check(r).calls, "--stdin-filename")).toEqual([PY]);
	});

	it("hands ruff every blob on stdin, never a path to read", () => {
		// ruff handed a path lints the worktree copy, and handed none it walks
		// the whole tree — the unscoped run the gate exists to avoid.
		const r = repo({ [PY]: `${OLD}${BODY}` }, { [PY]: `${NEW}${OLD}${BODY}` });
		const { calls } = check(r);
		expect(calls).toHaveLength(2);
		for (const argv of calls) expect(argv.at(-1)).toBe("-");
	});

	it("passes --config through to ruff", () => {
		const r = repo({}, { [PY]: BODY });
		const { calls } = check(r, { args: ["--config", "/plugin/ruff.toml"] });
		expect(valuesOf(calls, "--config")).toEqual(["/plugin/ruff.toml"]);
	});

	it("is BROKEN, naming the failure, when ruff itself fails", () => {
		// A ruff that cannot run has judged nothing, and passing would wave
		// through whatever the commit introduced.
		const r = repo({}, { [PY]: BODY });
		const { code, output } = check(r, { ruffExit: 2 });
		expect(output).toMatch(/exited 2 on pkg\/thing\.py/);
		expect(code).toBe(2);
	});
});

describe("the adopter's `ruffExclude`", () => {
	const scratch = ".scratch/probe.py";

	it("hands each pattern to ruff, with --force-exclude so a stdin path is excluded", () => {
		const r = repo({}, { [scratch]: BODY });
		writeHostConfig(r.root, { ruffExclude: [".scratch", "vendor/**"] });
		const { calls } = check(r);
		expect(calls[0]).toContain("--force-exclude");
		expect(valuesOf(calls, "--extend-exclude")).toEqual([
			".scratch",
			"vendor/**",
		]);
	});

	it("still forces ruff's exclusion when the host declares none", () => {
		// A host's own ruff `exclude` binds `ruff check .`; without the flag it
		// would not bind a path handed on stdin.
		const r = repo({}, { [PY]: BODY });
		expect(check(r).calls[0]).toContain("--force-exclude");
	});

	it("excludes nothing, and says so, when the value is not a list of strings", () => {
		// Failing open on the exclusion is the stricter reading: nothing
		// escapes the gate.
		const r = repo({}, { [scratch]: BODY });
		writeHostConfig(r.root, { ruffExclude: ".scratch" });
		const { calls, output } = check(r);
		expect(valuesOf(calls, "--extend-exclude")).toEqual([]);
		expect(output).toMatch(
			/"ruffExclude" is not an array of strings.*nothing is excluded/,
		);
	});

	it("excludes nothing, and says so, when the config does not parse", () => {
		const r = repo({}, { [scratch]: BODY });
		writeHostConfig(r.root, "{");
		const { code, calls, output } = check(r);
		expect(valuesOf(calls, "--extend-exclude")).toEqual([]);
		expect(output).toMatch(/ruffExclude unread, so nothing is excluded/);
		expect(code).toBe(0);
	});
});

describe.skipIf(!REAL_RUFF)("with the real ruff", () => {
	/** A repo carrying the plugin's select, judged by the machine's ruff. */
	function real(
		committed: Record<string, string>,
		staged: Record<string, string>,
	) {
		const r = repo({ "ruff.toml": PLUGIN_SELECT, ...committed }, staged);
		return check(r, { ruff: REAL_RUFF });
	}

	it("passes a line added above a pre-existing F811", () => {
		// ruff 0.16 writes F811 as "Redefinition of unused `os` from line 1".
		const src = "import os\nimport os\n\nprint(os)\n";
		const { code, output } = real({ [PY]: src }, { [PY]: `# added\n${src}` });
		expect(output).toMatch(/no ruff finding introduced/);
		expect(code).toBe(0);
	});

	it("does not lint a staged .scratch/ file the adopter excludes", () => {
		const staged = { ".scratch/probe.py": "print(undefined_name)\n" };
		const r = repo({ "ruff.toml": PLUGIN_SELECT }, staged);
		expect(check(r, { ruff: REAL_RUFF }).code).toBe(1);
		writeHostConfig(r.root, { ruffExclude: [".scratch"] });
		expect(check(r, { ruff: REAL_RUFF }).code).toBe(0);
	});
});
