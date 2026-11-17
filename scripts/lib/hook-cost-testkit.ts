/*
 * hook-cost-testkit.ts — the fixture a hot-path pin (base §G13, #5338) runs
 * its program in: a git repo on `main` with one commit pushed to a bare
 * `origin`, a contract-1 `.claude/workflow-core.json`, and an environment
 * holding nothing of the machine's but PATH.
 *
 * Each fixture is a lib/git-fixture.ts template, built once per test file
 * and copied per case: call `defineCostFixture` or `defineCommitFixture` at
 * module scope, and the function it returns in each beforeEach.
 *
 * FOR TESTS ONLY. Remove `dir` in the case's afterEach.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defineTemplate, mkDirOutsideRepo } from "./git-fixture";
import { shellQuote } from "./sh-quote.js";

/** The plugin root a hook line runs against: this checkout. */
const CHECKOUT = path.resolve(__dirname, "..", "..");

export interface CostFixture {
	/** The temp directory holding everything below. */
	dir: string;
	/** The fixture repo. */
	repo: string;
	/** The whole environment for a call. */
	env: Record<string, string | undefined>;
}

function costFixtureAt(dir: string): CostFixture {
	const repo = path.join(dir, "repo");
	return {
		dir,
		repo,
		env: {
			PATH: process.env.PATH,
			HOME: path.join(dir, "home"),
			CLAUDE_CONFIG_DIR: path.join(dir, "config"),
			CLAUDE_PROJECT_DIR: repo,
			CLAUDE_PLUGIN_ROOT: CHECKOUT,
			TMPDIR: path.join(dir, "tmp"),
			GIT_CONFIG_NOSYSTEM: "1",
		},
	};
}

const gitIn =
	(cwd: string, env: CostFixture["env"]) =>
	(...args: string[]) =>
		execFileSync("git", args, { cwd, env, encoding: "utf8" });

function buildCost(dir: string): void {
	for (const sub of ["home", "config", "tmp", "repo", "origin.git"])
		fs.mkdirSync(path.join(dir, sub));
	const { repo, env } = costFixtureAt(dir);
	gitIn(path.join(dir, "origin.git"), env)(
		"init",
		"-q",
		"--bare",
		"-b",
		"main",
	);
	const git = gitIn(repo, env);
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
}

/** Returns a copy of the fixture per call, its prefix naming the temp dir. */
export function defineCostFixture(): (prefix: string) => CostFixture {
	const template = defineTemplate(buildCost);
	return (prefix) => {
		const dir = mkDirOutsideRepo(prefix);
		template.instantiate(dir);
		return costFixtureAt(dir);
	};
}

/** The session worktree's name: its branch and its directory's. */
const WT_NAME = "pin-session";

const SESSION_WT = path.join(".claude", "worktrees", WT_NAME);

/** The session worktree's git dir in the fixture repo `repo`. */
const wtGitDir = (repo: string) =>
	path.join(repo, ".git", "worktrees", WT_NAME);

/** The session id an ordinary commit's session carries. */
const SESSION = "sess-5338";

export interface SessionWorktree {
	/** The session's linked worktree, under `.claude/worktrees/`. */
	wt: string;
	/** Its git dir, under the fixture repo's `.git/worktrees/`. */
	gitDir: string;
	git: (...args: string[]) => string;
}

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
 * Builds one ordinary commit, part made, into `dir`: a session's worktree
 * with one plain file staged and its message written.
 */
function buildCommit(dir: string): void {
	buildCost(dir);
	const { repo, env } = costFixtureAt(dir);
	const wt = path.join(repo, SESSION_WT);
	gitIn(repo, env)("worktree", "add", "-q", "-b", WT_NAME, wt);
	fs.writeFileSync(path.join(wt, "notes.txt"), "a note\n");
	gitIn(wt, env)("add", "notes.txt");
	fs.writeFileSync(path.join(wtGitDir(repo), "COMMIT_EDITMSG"), "Add a note\n");
}

/**
 * Returns a copy of the commit fixture per call. `claude` is a stub listing
 * this session, so no hook starts the machine's own.
 */
export function defineCommitFixture(): (prefix: string) => CommitFixture {
	const template = defineTemplate(buildCommit);
	return (prefix) => {
		const dir = mkDirOutsideRepo(prefix);
		template.instantiate(dir);
		const fx = costFixtureAt(dir);
		const wtDir = path.join(fx.repo, SESSION_WT);
		const gitDir = wtGitDir(fx.repo);
		const wt = { wt: wtDir, gitDir, git: gitIn(wtDir, fx.env) };
		const claude = path.join(dir, "bin", "claude");
		fs.mkdirSync(path.dirname(claude));
		fs.writeFileSync(
			claude,
			`#!/bin/sh\nprintf '%s\\n' ${shellQuote(JSON.stringify([{ sessionId: SESSION, cwd: wtDir }]))}\n`,
			{ mode: 0o755 },
		);
		const message = path.join(gitDir, "COMMIT_EDITMSG");
		return {
			fx,
			wt,
			env: {
				...fx.env,
				CLAUDE_PROJECT_DIR: wtDir,
				CLAUDECODE: "1",
				CLAUDE_CODE_SESSION_ID: SESSION,
				WFC_CLAUDE_BIN: claude,
				WFC_PLUGIN_ROOT: CHECKOUT,
				GIT_DIR: gitDir,
				GIT_INDEX_FILE: path.join(gitDir, "index"),
				GIT_EDITOR: ":",
				GIT_PREFIX: "",
				GIT_AUTHOR_NAME: "Pin",
				GIT_AUTHOR_EMAIL: "pin@example.invalid",
				GIT_AUTHOR_DATE: "@1794900000 +0000",
			},
			message,
			stamped: () =>
				fs.writeFileSync(
					path.join(gitDir, "wfc-precommit-stamp"),
					wt.git("write-tree"),
				),
			committed: () => {
				wt.git("commit", "-q", "-F", message);
			},
		};
	};
}
