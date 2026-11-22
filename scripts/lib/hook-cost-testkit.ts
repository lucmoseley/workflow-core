import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defineTemplate, mkDirOutsideRepo } from "./git-fixture";
import { shellQuote } from "./sh-quote.js";

const CHECKOUT = path.resolve(__dirname, "..", "..");

export interface CostFixture {
	dir: string;
	repo: string;
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

export function defineCostFixture(): (prefix: string) => CostFixture {
	const template = defineTemplate(buildCost);
	return (prefix) => {
		const dir = mkDirOutsideRepo(prefix);
		template.instantiate(dir);
		return costFixtureAt(dir);
	};
}

const WT_NAME = "pin-session";

const SESSION_WT = path.join(".claude", "worktrees", WT_NAME);

const wtGitDir = (repo: string) =>
	path.join(repo, ".git", "worktrees", WT_NAME);

const SESSION = "sess-5338";

export interface SessionWorktree {
	wt: string;
	gitDir: string;
	git: (...args: string[]) => string;
}

export interface CommitFixture {
	fx: CostFixture;
	wt: SessionWorktree;
	env: Record<string, string | undefined>;
	message: string;
	stamped: () => void;
	committed: () => void;
}

function buildCommit(dir: string): void {
	buildCost(dir);
	const { repo, env } = costFixtureAt(dir);
	const wt = path.join(repo, SESSION_WT);
	gitIn(repo, env)("worktree", "add", "-q", "-b", WT_NAME, wt);
	fs.writeFileSync(path.join(wt, "notes.txt"), "a note\n");
	gitIn(wt, env)("add", "notes.txt");
	fs.writeFileSync(path.join(wtGitDir(repo), "COMMIT_EDITMSG"), "Add a note\n");
}

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
