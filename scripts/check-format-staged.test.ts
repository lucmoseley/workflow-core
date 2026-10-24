// @vitest-environment node

/*
 * Pins that check-format-staged.js refuses a staged shell or Python path its
 * formatter would change, judging the staged blob and never the worktree, and
 * that the .husky/pre-commit block around it refuses the commit (#1332) — and
 * refuses with the install line where a formatter is missing, which the
 * checker calls BROKEN (#1354), skipping that half only where a workflow runs
 * the formatter (#1463).
 *
 * The checker runs in process in a throwaway repo, the hook block as `sh`.
 * shfmt is the core's own pinned copy, resolved through the checker's fallback
 * since the fixture has no node_modules; the Python cases need the machine's
 * ruff and skip without it, CI's node job having none.
 *
 * It is the format gate: loosen a case and unformatted shell or Python lands,
 * or a commit is refused for a neighbour's unstaged file.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RUFF_INSTALL, SHFMT_INSTALL } from "./lib/formatters.js";
import {
	cutGateScript,
	expectFixtureSupplies,
	registerTempCleanup,
	stagedRepo,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import { ROOT, writeCheckerDelegates } from "./lib/precommit-gate-testkit";
import { REAL_RUFF, writeHostConfig } from "./lib/ruff-testkit";
import { runInProcess } from "./lib/run-in-process.js";

const temps = registerTempCleanup();
const CHECKER = path.join(ROOT, "scripts", "check-format-staged.js");

const SH_OK = "if true; then\n  echo x\nfi\n";
const SH_BAD = "if true; then\n\techo x\nfi\n";
const PY_OK = 'print("x")\n';
const PY_BAD = "print( 'x' )\n";

/** A repo with `staged` written and staged over a one-file seed commit. */
function repo(staged: Record<string, string>): TempRepo {
	return stagedRepo("format-staged-", temps, {}, staged);
}

/** An absent `shfmt` leaves WFC_SHFMT unset, so the core's pinned copy loads. */
function check(
	r: TempRepo,
	opts: { ruff?: string; shfmt?: string; args?: string[] } = {},
): { code: number; output: string } {
	const run = runInProcess(CHECKER, opts.args ?? [], {
		cwd: r.root,
		env: {
			...process.env,
			WFC_RUFF: opts.ruff ?? REAL_RUFF,
			WFC_SHFMT: opts.shfmt,
			CLAUDE_PROJECT_DIR: r.root,
		},
	});
	return { code: run.status, output: `${run.stdout}${run.stderr}` };
}

describe("check-format-staged — shell", () => {
	it("is OK when no shell or Python path is staged", () => {
		const { code, output } = check(repo({ "notes.md": "# x\n" }));
		expect(output).toMatch(/OK: no staged shell or Python path/);
		expect(code).toBe(0);
	});

	it("refuses a staged script shfmt would change, naming it and the fix", () => {
		const { code, output } = check(repo({ "scripts/a.sh": SH_BAD }));
		expect(output).toMatch(/scripts\/a\.sh: not shfmt-formatted/);
		expect(output).toMatch(/Fix: node \S*shfmt\.js --write <path>/);
		expect(code).toBe(1);
	});

	it("refuses an unformatted husky hook, which has no .sh extension, naming its path", () => {
		const { code, output } = check(repo({ ".husky/pre-push": SH_BAD }));
		expect(output).toMatch(/\.husky\/pre-push: not shfmt-formatted/);
		expect(code).toBe(1);
	});

	it("refuses a script shfmt cannot parse, naming it", () => {
		const { code, output } = check(repo({ "scripts/a.sh": "if then fi (\n" }));
		expect(output).toMatch(/scripts\/a\.sh: shfmt cannot parse it/);
		expect(code).toBe(1);
	});

	it("passes a formatted staged script", () => {
		const { code } = check(repo({ "scripts/a.sh": SH_OK }));
		expect(code).toBe(0);
	});

	it("judges the staged blob, not the worktree copy", () => {
		const formattedOnDisk = repo({ "scripts/a.sh": SH_BAD });
		fs.writeFileSync(path.join(formattedOnDisk.root, "scripts/a.sh"), SH_OK);
		expect(check(formattedOnDisk).code).toBe(1);

		const unformattedOnDisk = repo({ "scripts/b.sh": SH_OK });
		fs.writeFileSync(path.join(unformattedOnDisk.root, "scripts/b.sh"), SH_BAD);
		expect(check(unformattedOnDisk).code).toBe(0);
	});

	it("refuses a .sh outside scripts/ and an extensionless shell-shebang file (#1828)", () => {
		const { code, output } = check(
			repo({ "tools/a.sh": SH_BAD, "bin/run": `#!/bin/sh\n${SH_BAD}` }),
		);
		expect(output).toMatch(/tools\/a\.sh: not shfmt-formatted/);
		expect(output).toMatch(/bin\/run: not shfmt-formatted/);
		expect(code).toBe(1);
	});

	it("leaves alone shell the staged .gitattributes marks vendored (#1828)", () => {
		const r = repo({
			".gitattributes": "vendor/** linguist-vendored\n",
			"vendor/a.sh": SH_BAD,
		});
		expect(check(r).code).toBe(0);
	});
});

describe.skipIf(!REAL_RUFF)(
	"check-format-staged — Python, with the real ruff",
	() => {
		it("refuses a staged .py ruff format would change, naming it", () => {
			const { code, output } = check(repo({ "pkg/a.py": PY_BAD }));
			expect(output).toMatch(/pkg\/a\.py: not ruff-formatted/);
			expect(code).toBe(1);
		});

		it("passes a formatted staged .py", () => {
			expect(check(repo({ "pkg/a.py": PY_OK })).code).toBe(0);
		});

		it("leaves a path in the adopter's `ruffExclude` alone", () => {
			const r = repo({ ".scratch/a.py": PY_BAD });
			writeHostConfig(r.root, { ruffExclude: [".scratch"] });
			expect(check(r).code).toBe(0);
		});
	},
);

describe("check-format-staged — a formatter that is not installed (#1354)", () => {
	const noRuff = { ruff: "/nonexistent/ruff" };
	const noShfmt = { shfmt: "/nonexistent/shfmt" };

	it("is BROKEN without ruff, naming the install line", () => {
		const { code, output } = check(repo({ "pkg/a.py": PY_BAD }), noRuff);
		expect(output).toMatch(/BROKEN: cannot run \/nonexistent\/ruff/);
		expect(output).toContain(`install it: ${RUFF_INSTALL}`);
		expect(code).toBe(2);
	});

	it("is BROKEN without shfmt, naming the install line", () => {
		const { code, output } = check(repo({ "scripts/a.sh": SH_BAD }), noShfmt);
		expect(output).toMatch(/BROKEN: @wasm-fmt\/shfmt is not installed/);
		expect(output).toContain(`install it: ${SHFMT_INSTALL}`);
		expect(code).toBe(2);
	});

	it("skips the Python half at --skip-python, saying so, and still checks the shell", () => {
		const { code, output } = check(
			repo({ "pkg/a.py": PY_BAD, "scripts/a.sh": SH_BAD }),
			{ ...noRuff, args: ["--skip-python"] },
		);
		expect(output).toMatch(
			/SKIPPED 1 path\(s\) at --skip-python: \/nonexistent\/ruff is not on PATH, and a workflow runs it — python3 -m pip install ruff==/,
		);
		expect(output).toMatch(/scripts\/a\.sh: not shfmt-formatted/);
		expect(code).toBe(1);
	});

	it("skips the shell half at --skip-shell, and SKIPs when nothing is left", () => {
		const { code, output } = check(repo({ "scripts/a.sh": SH_BAD }), {
			...noShfmt,
			args: ["--skip-shell"],
		});
		expect(output).toMatch(
			/SKIPPED 1 path\(s\) at --skip-shell: @wasm-fmt\/shfmt is not installed, and a workflow runs it — npm install/,
		);
		expect(output).toMatch(/SKIP: every staged shell and Python path skipped/);
		expect(code).toBe(0);
	});

	it("says nothing of a skipped half the commit stages no path for", () => {
		const { code, output } = check(repo({ "scripts/a.sh": SH_OK }), {
			args: ["--skip-python"],
		});
		expect(output).not.toMatch(/SKIPPED/);
		expect(code).toBe(0);
	});
});

describe("the .husky/pre-commit format gate", () => {
	const anchorPath = "check-format-staged.js";

	const probePath = "lib/formatters.js";

	/**
	 * Runs the cut gate block in `r`, with the checker and the formatter probe
	 * delegated to the core's.
	 */
	function gate(
		r: TempRepo,
		env: object = {},
		probe?: string,
	): { code: number; output: string } {
		expectFixtureSupplies(anchorPath, [
			`scripts/${anchorPath}`,
			`scripts/${probePath}`,
		]);
		writeCheckerDelegates(r.root, [anchorPath, probePath]);
		if (probe) fs.writeFileSync(path.join(r.root, "scripts", probePath), probe);
		const run = spawnSync("sh", ["-c", cutGateScript(anchorPath)], {
			cwd: r.root,
			encoding: "utf8",
			env: {
				...process.env,
				WFC_RUFF: REAL_RUFF || "/nonexistent/ruff",
				...env,
			},
		});
		return { code: run.status ?? 1, output: `${run.stdout}${run.stderr}` };
	}

	it("refuses the commit on an unformatted staged script", () => {
		const { code, output } = gate(repo({ "scripts/a.sh": SH_BAD }));
		expect(output).toMatch(/the format gate refused/);
		expect(code).toBe(1);
	});

	it("refuses the commit when the formatter probe crashes rather than answering, never skipping (#1354)", () => {
		const { code, output } = gate(
			repo({ "scripts/a.sh": SH_OK }),
			{},
			"process.exit(3);\n",
		);
		expect(output).toMatch(
			/the formatter probe failed, so the format gate refused/,
		);
		expect(code).toBe(1);
	});

	// The paired case: a commit only deleting a shell path does not arm the
	// gate, so the same crashing probe never runs (#1504's review).
	it("passes a commit that only deletes a shell path, never running the probe", () => {
		const r = repo({ "scripts/a.sh": SH_OK });
		r.git("commit", "-qm", "add");
		r.git("rm", "-q", "--", "scripts/a.sh");
		const { code, output } = gate(r, {}, "process.exit(3);\n");
		expect(output).not.toMatch(/the formatter probe failed/);
		expect(code).toBe(0);
	});

	/** `r` with a workflow whose one step runs `command`. */
	const withWorkflow = (r: TempRepo, command: string) => {
		const dir = path.join(r.root, ".github", "workflows");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "ci.yml"), `      - run: ${command}\n`);
		return r;
	};
	const envNoShfmt = { WFC_SHFMT: "/nonexistent/shfmt" };
	const envNoRuff = { WFC_RUFF: "/nonexistent/ruff" };

	it("refuses a shell path where shfmt is missing and no workflow runs it, naming the install line (#1463)", () => {
		const { code, output } = gate(repo({ "scripts/a.sh": SH_OK }), envNoShfmt);
		expect(output).toContain(SHFMT_INSTALL);
		expect(output).toMatch(/the format gate refused/);
		expect(code).toBe(1);
	});

	it("skips the shell half where shfmt is missing and a workflow runs it (#1354, #1463)", () => {
		const r = withWorkflow(repo({ "scripts/a.sh": SH_BAD }), "shfmt -d .");
		const { code, output } = gate(r, envNoShfmt);
		expect(output).toMatch(/SKIPPED 1 path\(s\) at --skip-shell/);
		expect(code).toBe(0);
	});

	it("refuses a Python path where ruff is missing and no workflow runs it, naming the install line (#1463)", () => {
		const { code, output } = gate(repo({ "pkg/a.py": PY_OK }), envNoRuff);
		expect(output).toContain(RUFF_INSTALL);
		expect(output).toMatch(/the format gate refused/);
		expect(code).toBe(1);
	});

	it("skips the Python half where ruff is missing and a workflow runs it, saying so, and still refuses unformatted shell, naming it (#1354, #1463)", () => {
		const r = withWorkflow(
			repo({ "pkg/a.py": PY_BAD, "scripts/a.sh": SH_BAD }),
			"ruff format --check .",
		);
		const { code, output } = gate(r, envNoRuff);
		expect(output).toMatch(/SKIPPED 1 path\(s\) at --skip-python/);
		expect(output).toMatch(/scripts\/a\.sh: not shfmt-formatted/);
		expect(code).toBe(1);
	});

	it("never runs the checker when no shell or Python path is staged", () => {
		const r = repo({ "notes.md": "# x\n" });
		// No delegate written: a call would fail on the missing script.
		const run = spawnSync("sh", ["-c", cutGateScript(anchorPath)], {
			cwd: r.root,
			encoding: "utf8",
		});
		expect(run.status).toBe(0);
	});
});
