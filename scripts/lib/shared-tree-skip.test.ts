// @vitest-environment node
/*
 * scripts/lib/shared-tree-skip.sh's own suite (#123): the stale-write-back
 * family proceeds only in the shared tree, stands down in a linked worktree or
 * a foreign repo, and says distinctly when git will not answer.
 *
 * The three verdicts are driven directly, in both shells that source the
 * library: bash, for scripts/stale-write-back-gate.sh, and dash where it is
 * installed, for .husky/post-commit's `sh -e`. Each runs in a throwaway repo
 * with a real linked worktree, never this checkout.
 *
 * The gate refuses in `.husky/pre-commit`; loosen a case and a worktree commit
 * is judged against the shared tree's bases and refused wrongly, or the main
 * tree stands down and a stale write-back lands unrefused.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const LIB = path.join(__dirname, "shared-tree-skip.sh");

const temps: string[] = [];
afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
});

/** A throwaway repo with one commit, so `git worktree add` has something to branch. */
function newRepo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-tree-skip-"));
	temps.push(root);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
	git("init", "-q", ".");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	git("commit", "-q", "--allow-empty", "-m", "seed");
	return root;
}

/**
 * The library's verdict in `cwd`: its exit code, and the two variables it sets
 * for the caller.
 */
function verdict(
	cwd: string,
	{
		shell = "bash",
		env = {},
		given = "",
	}: {
		shell?: string;
		env?: Record<string, string>;
		/** What post-commit passes as $1, having read it to find the library. */
		given?: string;
	} = {},
) {
	const r = spawnSync(
		shell,
		[
			"-c",
			`. "${LIB}"; wfc_shared_tree_skip "$1"; rc=$?; printf '%s\\n%s\\n%s\\n' "$rc" "$wfc_sts_gitdir" "$wfc_sts_toplevel"`,
			"sh",
			given,
		],
		{
			cwd,
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: "", ...env },
		},
	);
	const [rc, gitdir, toplevel] = r.stdout.split("\n");
	return { rc: Number(rc), gitdir, toplevel, stderr: r.stderr };
}

/** dash, where this machine has it: post-commit runs under `sh`, not bash. */
const DASH = spawnSync("sh", ["-c", "command -v dash"], {
	encoding: "utf8",
}).stdout.trim();

describe("wfc_shared_tree_skip", () => {
	it("proceeds in the main worktree, and hands the caller its two reads", () => {
		const root = newRepo();
		const v = verdict(root);
		expect(v.rc).toBe(0);
		expect(v.gitdir).toBe(path.join(fs.realpathSync(root), ".git"));
		expect(fs.realpathSync(v.toplevel)).toBe(fs.realpathSync(root));
	});

	it("stands down in a linked worktree, whose HEAD is not the shared tree's", () => {
		const root = newRepo();
		const wt = path.join(root, "..", `${path.basename(root)}-wt`);
		temps.push(wt);
		execFileSync("git", ["worktree", "add", "-q", "-b", "wt", wt], {
			cwd: root,
		});
		expect(verdict(wt).rc).toBe(1);
	});

	it("stands down in a repo that is not CLAUDE_PROJECT_DIR's", () => {
		const mine = newRepo();
		const theirs = newRepo();
		expect(verdict(theirs, { env: { CLAUDE_PROJECT_DIR: mine } }).rc).toBe(1);
		expect(verdict(mine, { env: { CLAUDE_PROJECT_DIR: mine } }).rc).toBe(0);
	});

	it("judges the toplevel its caller passes, sparing itself the second rev-parse", () => {
		const mine = newRepo();
		const theirs = newRepo();
		// The passed value decides, not the cwd: post-commit reads its toplevel to
		// find this library at all, and hands the same one back.
		expect(
			verdict(mine, { given: theirs, env: { CLAUDE_PROJECT_DIR: mine } }).rc,
		).toBe(1);
		expect(verdict(mine, { given: mine }).toplevel).toBe(mine);
	});

	it("reads a symlinked checkout as the repo it points at, not a foreign one", () => {
		const root = newRepo();
		const link = fs.mkdtempSync(path.join(os.tmpdir(), "shared-tree-link-"));
		temps.push(link);
		const alias = path.join(link, "repo");
		fs.symlinkSync(root, alias);
		expect(verdict(alias, { env: { CLAUDE_PROJECT_DIR: root } }).rc).toBe(0);
	});

	it("reports 2, distinctly from a stand-down, where git will not answer at all", () => {
		const bare = fs.mkdtempSync(path.join(os.tmpdir(), "shared-tree-nogit-"));
		temps.push(bare);
		// GIT_CEILING_DIRECTORIES stops the upward search, so no repo is found here
		// even though the temp dir may sit inside one.
		const v = verdict(bare, { env: { GIT_CEILING_DIRECTORIES: os.tmpdir() } });
		expect(v.rc).toBe(2);
	});

	it("makes the gate fail open, loudly, when the library is not there at all", () => {
		// The gate sources by BASH_SOURCE, so a checkout missing only this file is
		// the way to reach its rc=3 branch.
		const root = newRepo();
		fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
		const repo = path.join(__dirname, "..", "..");
		for (const rel of [
			"scripts/stale-write-back-gate.sh",
			"scripts/lib/guard-log.sh",
			"scripts/lib/rule-text.sh",
		])
			fs.copyFileSync(path.join(repo, rel), path.join(root, rel));

		const r = spawnSync(
			"bash",
			[path.join(root, "scripts/stale-write-back-gate.sh")],
			{
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					CLAUDE_CODE_SESSION_ID: "alice",
					CLAUDE_PROJECT_DIR: root,
				},
			},
		);
		// Fail OPEN: the commit is let through, and the session is told it was
		// never checked.
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("scripts/lib/shared-tree-skip.sh");
		expect(r.stderr).toContain("this commit is NOT checked");
	});

	it.skipIf(!DASH)("gives dash the same three verdicts as bash", () => {
		const root = newRepo();
		const theirs = newRepo();
		expect(verdict(root, { shell: "dash" }).rc).toBe(0);
		expect(
			verdict(theirs, { shell: "dash", env: { CLAUDE_PROJECT_DIR: root } }).rc,
		).toBe(1);
		expect(
			verdict(root, {
				shell: "dash",
				env: { GIT_CEILING_DIRECTORIES: os.tmpdir(), GIT_DIR: "/nonexistent" },
			}).rc,
		).toBe(2);
	});
});
