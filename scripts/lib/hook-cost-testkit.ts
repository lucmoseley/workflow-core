/*
 * hook-cost-testkit.ts — the fixture a hot-path pin (base §G13, #5338) runs
 * its program in: a git repo on `main` with one commit pushed to a bare
 * `origin`, a contract-1 `.claude/workflow-core.json`, and an environment
 * holding nothing of the machine's but PATH. HOME, the config dir, the project dir and TMPDIR all
 * sit inside the fixture, so a pin neither reads this machine's state nor
 * writes to it, and its lists do not move with what the machine holds.
 *
 * FOR TESTS ONLY. Remove `dir` in the case's afterEach.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The plugin root a hook line runs against: this checkout. */
const CHECKOUT = path.resolve(__dirname, "..", "..");

export interface CostFixture {
	/** The temp directory holding everything below; remove it after. */
	dir: string;
	/** The fixture repo, and the call's project dir. */
	repo: string;
	/** The whole environment for a call. */
	env: Record<string, string | undefined>;
	/** Runs git in the fixture repo under `env`. */
	git: (...args: string[]) => string;
}

export function costFixture(prefix: string): CostFixture {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	for (const sub of ["home", "config", "tmp", "repo", "origin.git"])
		fs.mkdirSync(path.join(dir, sub));
	const repo = path.join(dir, "repo");
	const env = {
		PATH: process.env.PATH,
		HOME: path.join(dir, "home"),
		CLAUDE_CONFIG_DIR: path.join(dir, "config"),
		CLAUDE_PROJECT_DIR: repo,
		CLAUDE_PLUGIN_ROOT: CHECKOUT,
		TMPDIR: path.join(dir, "tmp"),
		GIT_CONFIG_NOSYSTEM: "1",
	};
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
	execFileSync("git", ["init", "-q", "--bare", "-b", "main"], {
		cwd: path.join(dir, "origin.git"),
		env,
	});
	git("init", "-q", "-b", "main");
	git("config", "user.name", "Pin");
	git("config", "user.email", "pin@example.invalid");
	fs.mkdirSync(path.join(repo, ".claude"));
	fs.writeFileSync(
		path.join(repo, ".claude", "workflow-core.json"),
		'{ "contract": 1 }\n',
	);
	fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
	fs.writeFileSync(path.join(repo, ".gitignore"), ".claude/worktrees/\n");
	git("add", ".");
	git("commit", "-q", "-m", "fixture");
	git("remote", "add", "origin", path.join(dir, "origin.git"));
	git("push", "-q", "-u", "origin", "main");
	return { dir, repo, env, git };
}

export interface SessionWorktree {
	/** The session's linked worktree, under `.claude/worktrees/`. */
	wt: string;
	/** Its git dir, under the fixture repo's `.git/worktrees/`. */
	gitDir: string;
	/** Runs git in the worktree under the fixture's env. */
	git: (...args: string[]) => string;
}

/** A session's linked worktree of `fx.repo`, where a session commits. */
export function sessionWorktree(fx: CostFixture): SessionWorktree {
	const wt = path.join(fx.repo, ".claude", "worktrees", "pin-session");
	fx.git("worktree", "add", "-q", "-b", "pin-session", wt);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: wt, env: fx.env, encoding: "utf8" });
	return { wt, gitDir: git("rev-parse", "--absolute-git-dir").trim(), git };
}

/** The session id an ordinary commit's session carries. */
const SESSION = "sess-5338";

export interface CommitFixture {
	fx: CostFixture;
	wt: SessionWorktree;
	/** The env git hands a hook on this commit, the session's included. */
	env: Record<string, string | undefined>;
	/** The message file git hands prepare-commit-msg and commit-msg. */
	message: string;
	/** Leaves the stand-down stamp .husky/pre-commit writes on a pass. */
	stamped: () => void;
	/** Makes the commit, as git does before post-commit. */
	committed: () => void;
}

/**
 * One ordinary commit, part made: a session's worktree with one plain file
 * staged and its message written. `claude` is a stub listing this session,
 * so no hook starts the machine's own.
 */
export function commitFixture(prefix: string): CommitFixture {
	const fx = costFixture(prefix);
	const wt = sessionWorktree(fx);
	const claude = path.join(fx.dir, "bin", "claude");
	fs.mkdirSync(path.dirname(claude));
	fs.writeFileSync(
		claude,
		`#!/bin/sh\nprintf '[{"sessionId":"${SESSION}","cwd":"%s"}]\\n' '${wt.wt}'\n`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(path.join(wt.wt, "notes.txt"), "a note\n");
	wt.git("add", "notes.txt");
	const message = path.join(wt.gitDir, "COMMIT_EDITMSG");
	fs.writeFileSync(message, "Add a note\n");
	return {
		fx,
		wt,
		env: {
			...fx.env,
			CLAUDE_PROJECT_DIR: wt.wt,
			CLAUDECODE: "1",
			CLAUDE_CODE_SESSION_ID: SESSION,
			WFC_CLAUDE_BIN: claude,
			WFC_PLUGIN_ROOT: CHECKOUT,
			GIT_DIR: wt.gitDir,
			GIT_INDEX_FILE: path.join(wt.gitDir, "index"),
			GIT_EDITOR: ":",
			GIT_PREFIX: "",
			GIT_AUTHOR_NAME: "Pin",
			GIT_AUTHOR_EMAIL: "pin@example.invalid",
			GIT_AUTHOR_DATE: "@1794900000 +0000",
		},
		message,
		stamped: () =>
			fs.writeFileSync(
				path.join(wt.gitDir, "wfc-precommit-stamp"),
				wt.git("write-tree"),
			),
		committed: () => {
			wt.git("commit", "-q", "-F", message);
		},
	};
}
