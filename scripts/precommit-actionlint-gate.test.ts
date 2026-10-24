// @vitest-environment node

/*
 * The pre-commit actionlint gate (mantahostels#1137), exercised as the shell it is.
 *
 * `.husky/pre-commit` runs actionlint only when the commit stages a file under
 * `.github/workflows/`, hands it exactly those paths, and fails the commit when
 * actionlint exits non-zero. The CI half — `ci.yml`'s actionlint step, the only
 * re-check of a workflow a neighbour's commit changed — is read from the file
 * and pinned too.
 *
 * actionlint itself is stubbed as a script on PATH, so both exit codes are ours
 * to drive and no case depends on the repo's real workflows being clean.
 *
 * Both halves are hard gates: loosen a case here and a broken workflow lands
 * on `main` unrefused, to fail only when GitHub next runs it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	cutGateFragment,
	registerTempCleanup,
	stagedRepo,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import { LIB, LIB_COMMANDS, ROOT } from "./lib/precommit-gate-testkit";

const temps = registerTempCleanup();

// Anchored on the shell variable holding the path list, not on any flag or
// message: the cutter must survive a mutation to anything the cases below
// assert, or removing one would break every case by throwing rather than by
// failing the single case that guards it.
const gateFragment = () => cutGateFragment("actionlint $tool_paths");

/** Where the stub records the argv it was handed, one path per line. */
const ARGS_FILE = "actionlint-args.txt";

/**
 * What an isolated fixture's PATH must hold: the commands the cut fragment
 * and the library's arming read shell out to, plus `sh` itself —
 * execFileSync resolves the shell against the CHILD's PATH, so omitting it
 * fails the spawn with no output at all rather than failing the gate.
 */
const NEEDED = ["sh", ...LIB_COMMANDS];

/**
 * Populates `bin` with a symlink to each of NEEDED, so a PATH of `bin` alone
 * runs the fragment with NO actionlint reachable.
 *
 * Built up rather than subtracted from `process.env.PATH`: subtracting every
 * directory holding an `actionlint` removes ~/.local/bin here, which is also
 * where this machine's shellcheck and gitleaks live — so the absent-binary case
 * would pass or fail on the host rather than on the gate.
 */
function linkNeeded(bin: string): void {
	for (const cmd of NEEDED) {
		const abs = execFileSync("sh", ["-c", `command -v ${cmd}`], {
			encoding: "utf8",
		}).trim();
		fs.symlinkSync(abs, path.join(bin, cmd));
	}
}

/**
 * A git repo with one commit and `staged` written and staged, plus — unless
 * `stub` is false — a stubbed `actionlint` on PATH whose exit code is ours.
 *
 * The stub records its argv even when handed none, which is what lets the
 * whole-directory cases below tell "not invoked" from "invoked bare".
 */
function fixture(opts: {
	staged: Record<string, string>;
	actionlintExit?: number;
	stub?: boolean;
}): TempRepo & { bin: string; isolated: boolean } {
	const repo = stagedRepo("actionlint-gate-", temps, {}, opts.staged);
	const { root } = repo;

	const bin = path.join(root, "stub-bin");
	fs.mkdirSync(bin, { recursive: true });
	if (opts.stub === false) {
		linkNeeded(bin);
	} else {
		const stub = path.join(bin, "actionlint");
		// `$#` is recorded first, so an invocation with NO arguments still leaves
		// a line behind — a bare `actionlint` scans the whole workflows
		// directory, and a stub silent about it would be indistinguishable from
		// not being called.
		fs.writeFileSync(
			stub,
			`#!/bin/sh\nprintf 'argc=%s\\n' "$#" >>"${path.join(root, ARGS_FILE)}"\nprintf '%s\\n' "$@" >>"${path.join(root, ARGS_FILE)}"\nexit ${opts.actionlintExit ?? 0}\n`,
		);
		fs.chmodSync(stub, 0o755);
	}

	return { ...repo, bin, isolated: opts.stub === false };
}

function runGate(repo: { root: string; bin: string; isolated?: boolean }): {
	code: number;
	output: string;
	args: string[];
	invoked: boolean;
} {
	let code = 0;
	let output = "";
	// A trailing no-op stands in for the rest of the hook, which really does
	// continue past this gate. Without it the fragment's own exit status is
	// actionlint's, and the `|| { … exit 1; }` block could be deleted with every
	// case still green.
	// `exec 2>&1` because every message this gate prints goes to stderr, which
	// execFileSync surfaces only on a non-zero exit — the warn-and-pass case
	// would otherwise assert against an empty string and pass whatever the hook
	// printed.
	const script = `exec 2>&1\n${LIB}\n${gateFragment()}\n:\n`;
	// An isolated fixture withheld the stub, so its bin holds only the NEEDED
	// commands and must stand ALONE as PATH — appending the real one would hand
	// the fragment the machine's own actionlint back.
	const search = repo.isolated
		? repo.bin
		: `${repo.bin}${path.delimiter}${process.env.PATH ?? ""}`;
	try {
		output = execFileSync("sh", ["-c", script], {
			cwd: repo.root,
			encoding: "utf8",
			env: { ...process.env, PATH: search },
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		code = err.status ?? 1;
		output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
	}
	const argsPath = path.join(repo.root, ARGS_FILE);
	const lines = fs.existsSync(argsPath)
		? fs.readFileSync(argsPath, "utf8").split("\n").filter(Boolean)
		: [];
	return {
		code,
		output,
		args: lines.filter((l) => !l.startsWith("argc=")),
		invoked: lines.some((l) => l.startsWith("argc=")),
	};
}

const WORKFLOW = ".github/workflows/ci.yml";
const OUTSIDE = "scripts/thing.js";
const BODY =
	"name: t\non: workflow_dispatch\njobs:\n  a:\n    runs-on: ubuntu-latest\n";

describe("the pre-commit actionlint gate", () => {
	it("does not run actionlint when the commit stages no workflow file", () => {
		const repo = fixture({
			staged: { [OUTSIDE]: "const a = 1;\n", "docs/x.md": "# x\n" },
			// Red, so a gate that fired anyway would fail the case rather than
			// passing by luck.
			actionlintExit: 1,
		});
		const { code, invoked } = runGate(repo);
		expect(invoked).toBe(false);
		expect(code).toBe(0);
	});

	it("does not fire on a YAML file outside .github/workflows/", () => {
		// The repo has YAML elsewhere (skills, fixtures). actionlint reads only
		// workflow files, so a gate anchored on `\.ya?ml$` alone would hand it
		// files it cannot parse and fail commits that touch them.
		const repo = fixture({
			staged: { ".github/dependabot.yml": BODY, "docs/x.yaml": BODY },
			actionlintExit: 1,
		});
		expect(runGate(repo).invoked).toBe(false);
	});

	it("runs actionlint on a staged workflow and passes when it is green", () => {
		const repo = fixture({ staged: { [WORKFLOW]: BODY }, actionlintExit: 0 });
		const { code, args } = runGate(repo);
		expect(args).toContain(WORKFLOW);
		expect(code).toBe(0);
	});

	it("matches the .yaml spelling as well as .yml", () => {
		// Every file in .github/workflows/ is .yml today, so a gate anchored on
		// that one extension would silently never fire on a workflow added under
		// the other — which GitHub accepts identically.
		const alt = ".github/workflows/new.yaml";
		const repo = fixture({ staged: { [alt]: BODY }, actionlintExit: 0 });
		expect(runGate(repo).args).toContain(alt);
	});

	it("fails the commit when actionlint exits non-zero", () => {
		const repo = fixture({ staged: { [WORKFLOW]: BODY }, actionlintExit: 1 });
		const { code, output } = runGate(repo);
		expect(code).toBe(1);
		expect(output).toMatch(/actionlint failed on this commit's own/);
	});

	it("hands actionlint only the commit's own workflow paths", () => {
		const repo = fixture({
			staged: { [WORKFLOW]: BODY, [OUTSIDE]: "const a = 1;\n" },
			actionlintExit: 0,
		});
		const { args } = runGate(repo);
		expect(args).toContain(WORKFLOW);
		expect(args).not.toContain(OUTSIDE);
	});

	it("reads the commit's staged paths, NOT the whole workflows directory", () => {
		// This is the only case pinning scoped-not-whole-directory. Every other
		// fixture's only tracked workflow IS its staged one, so dropping the path
		// list for a bare `actionlint` leaves them all green — and a bare run in
		// the shared tree fails this commit on a parallel session's half-written
		// workflow (mantahostels#1137).
		const tracked = ".github/workflows/untouched.yml";
		const repo = fixture({ staged: {}, actionlintExit: 0 });
		fs.mkdirSync(path.join(repo.root, ".github", "workflows"), {
			recursive: true,
		});
		fs.writeFileSync(path.join(repo.root, tracked), BODY);
		repo.git("add", "--", tracked);
		repo.git("commit", "-qm", "tracked");

		fs.writeFileSync(path.join(repo.root, WORKFLOW), BODY);
		repo.git("add", "--", WORKFLOW);

		const { code, args } = runGate(repo);
		expect(args).toContain(WORKFLOW);
		expect(args).not.toContain(tracked);
		expect(code).toBe(0);
	});

	it("drops a deletion from a commit that ALSO stages a live workflow", () => {
		// A commit staging only a deletion never opens the gate at all, so that
		// case would pass with no --diff-filter on the path list. Forcing the
		// gate open with a live file is what makes the filter load-bearing:
		// without it actionlint is handed a path with no file behind it.
		const gone = ".github/workflows/gone.yml";
		const repo = fixture({ staged: {}, actionlintExit: 0 });
		fs.mkdirSync(path.join(repo.root, ".github", "workflows"), {
			recursive: true,
		});
		// Deliberately unlike BODY. Two identical short files read to git as one
		// RENAME rather than a delete plus an add, and a rename stages no
		// deletion at all — so the case would pass with the filter gone.
		fs.writeFileSync(
			path.join(repo.root, gone),
			`name: gone\n${"# distinct\n".repeat(12)}on: workflow_dispatch\n`,
		);
		repo.git("add", "--", gone);
		repo.git("commit", "-qm", "add");
		repo.git("rm", "-q", "--", gone);

		fs.mkdirSync(path.join(repo.root, ".github", "workflows"), {
			recursive: true,
		});
		fs.writeFileSync(path.join(repo.root, WORKFLOW), BODY);
		repo.git("add", "--", WORKFLOW);

		const { code, args } = runGate(repo);
		expect(args).toContain(WORKFLOW);
		expect(args).not.toContain(gone);
		expect(code).toBe(0);
	});

	it("drops a path the commit UNTRACKS but leaves on disk", () => {
		// armed_live's A/M match on the path list, and the only case that can
		// see it: `git rm --cached` stages a deletion while the file stays in the
		// worktree, so its `[ -f ]` half happily keeps it. Without the
		// filter actionlint is handed a workflow this commit is REMOVING from the
		// repo, and a finding in it blocks the removal.
		const untracked = ".github/workflows/retired.yml";
		const repo = fixture({ staged: {}, actionlintExit: 0 });
		fs.mkdirSync(path.join(repo.root, ".github", "workflows"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(repo.root, untracked),
			`name: retired\n${"# distinct\n".repeat(12)}on: workflow_dispatch\n`,
		);
		repo.git("add", "--", untracked);
		repo.git("commit", "-qm", "add");
		repo.git("rm", "-q", "--cached", "--", untracked);

		fs.writeFileSync(path.join(repo.root, WORKFLOW), BODY);
		repo.git("add", "--", WORKFLOW);

		const { code, args } = runGate(repo);
		expect(args).toContain(WORKFLOW);
		expect(args).not.toContain(untracked);
		expect(code).toBe(0);
	});

	it("does not invoke actionlint at all when every staged path has been deleted from the worktree", () => {
		// The `[ -z "$al_paths" ]` guard. actionlint with no arguments does not
		// error — it scans the WHOLE workflows directory, so dropping that guard
		// turns the emptiest possible case into the unscoped run this gate exists
		// to avoid.
		const repo = fixture({ staged: { [WORKFLOW]: BODY }, actionlintExit: 1 });
		fs.rmSync(path.join(repo.root, WORKFLOW));
		const { code, invoked } = runGate(repo);
		expect(invoked).toBe(false);
		expect(code).toBe(0);
	});

	it("warns and PASSES when actionlint is not on PATH", () => {
		const repo = fixture({ staged: { [WORKFLOW]: BODY }, stub: false });
		const { code, output } = runGate(repo);
		expect(code).toBe(0);
		expect(output).toMatch(/actionlint is not on PATH — its gate is SKIPPED/);
		expect(output).toMatch(/NOT blocked/);
	});

	it("says nothing about a missing binary on a commit staging no workflow", () => {
		// `stub: false` is what makes this a test. With the stub present the
		// SKIPPED branch is unreachable whatever the gate does, so the case would
		// stay green with the whole file-set condition deleted.
		const repo = fixture({
			staged: { [OUTSIDE]: "const a = 1;\n" },
			stub: false,
		});
		expect(runGate(repo).output).not.toMatch(/SKIPPED/);
	});

	it("passes no flags, matching check:actions, which owns their rationale", () => {
		// actionlint's defaults are what mantahostels#1137's four mutations were measured
		// against, and CI runs the npm script rather than the binary so the two
		// halves cannot drift. A flag appearing on either side without the other
		// is exactly the divergence this pins.
		const pkg = JSON.parse(
			fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
		);
		expect(pkg.scripts["check:actions"]).toBe("actionlint");
		// The path list and nothing else between the command and the `|| { … }`
		// failure block.
		const invocation = /^\s*actionlint ([^|]*)\|\| \{/m.exec(gateFragment());
		expect(
			invocation,
			"the gate no longer invokes actionlint ahead of a `||`",
		).not.toBeNull();
		expect((invocation as RegExpExecArray)[1].trim()).toBe("$tool_paths");
	});
});

describe("the CI half of the same gate", () => {
	const ci = fs.readFileSync(
		path.join(ROOT, ".github", "workflows", "ci.yml"),
		"utf8",
	);
	const step = (): string => {
		const m = /- name: actionlint\n((?:.*\n)*?) {6}- name:/.exec(ci);
		expect(
			m,
			"the actionlint step no longer parses out of ci.yml",
		).not.toBeNull();
		return (m as RegExpExecArray)[1];
	};

	it("runs the same npm script the local by-hand route does", () => {
		// The pre-commit gate reads only the paths a commit names, so this step is
		// the only thing that ever re-checks a workflow a neighbouring commit
		// changed under it.
		expect(step()).toContain("npm run check:actions");
	});

	it("hard-fails, carrying no continue-on-error and no absent-binary escape", () => {
		// Deliberately unlike the pre-commit half, which warns and passes: a
		// runner that cannot fetch the tarball has a broken install, not a fresh
		// machine (mantahostels#1137).
		expect(step()).not.toContain("continue-on-error");
		expect(step()).not.toMatch(/command -v actionlint/);
	});

	it("pins the download to a version AND a checksum, and verifies before use", () => {
		const body = step();
		const version = /ACTIONLINT_VERSION: (\S+)/.exec(body);
		const sha = /ACTIONLINT_SHA256: ([0-9a-f]{64})\b/.exec(body);
		expect(
			version,
			"the actionlint version is no longer pinned",
		).not.toBeNull();
		expect(
			sha,
			"the actionlint tarball checksum is no longer pinned",
		).not.toBeNull();
		// The URL is built from the pinned version rather than carrying its own
		// literal, so a bump cannot leave the two disagreeing.
		expect(body).toContain("$ACTIONLINT_VERSION");
		expect(body).not.toMatch(
			new RegExp(`download/v${(version as RegExpExecArray)[1]}`),
		);
		// Order matters: a `sha256sum -c` after the archive has been unpacked and
		// run checks a binary already trusted.
		expect(body.indexOf("sha256sum -c")).toBeGreaterThan(body.indexOf("curl"));
		expect(body.indexOf("sha256sum -c")).toBeLessThan(body.indexOf("tar -xzf"));
	});
});
