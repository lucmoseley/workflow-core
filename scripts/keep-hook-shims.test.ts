// @vitest-environment node
/*
 * keep-hook-shims.js's boundary set (#2879): the program run in process on a
 * temp repository whose reflog is dated through GIT_COMMITTER_DATE, git and
 * fs crossed for real, and the liveness listing a fake `claude` on
 * WFC_CLAUDE_BIN (§N7).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { runInProcess } = require("./lib/run-in-process.js");

const ENTRY = path.join(__dirname, "keep-hook-shims.js");

let repo: string;
let bin: string;
let config: string;

const git = (args: string[], at?: number) =>
	execFileSync("git", ["-C", repo, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
			...(at === undefined ? {} : { GIT_COMMITTER_DATE: `@${at} +0000` }),
		},
	});

const hooksNaming = (script: string) =>
	JSON.stringify({
		hooks: {
			PreToolUse: [
				{
					matcher: "Bash",
					hooks: [
						{
							type: "command",
							command: `\${CLAUDE_PROJECT_DIR}/scripts/${script}`,
						},
					],
				},
			],
		},
	});

const write = (rel: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
	fs.writeFileSync(path.join(repo, rel), text);
};

/** Runs the keeper with one live session, started at `startedAt` seconds. */
function keep(startedAt: number, cwd = repo, ...args: string[]) {
	fs.writeFileSync(
		bin,
		`#!/bin/sh\necho '[{"sessionId":"s1","startedAt":${startedAt * 1000}}]'\n`,
	);
	fs.chmodSync(bin, 0o755);
	return runInProcess(ENTRY, args, {
		cwd,
		env: {
			...process.env,
			CLAUDE_CONFIG_DIR: config,
			WFC_CLAUDE_BIN: bin,
			WFC_ORACLE_CACHE: "0",
			WFC_OVERFLOW_ENV_ROOT: path.dirname(bin),
		},
	});
}

const shim = () => path.join(repo, "scripts/guard-x.sh");

beforeEach(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "hook-shims-"));
	config = fs.mkdtempSync(path.join(os.tmpdir(), "hook-shims-config-"));
	bin = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "hook-shims-bin-")),
		"claude",
	);
	git(["init", "-q", "-b", "main"]);
	write("self-plugin/hooks/hooks.json", hooksNaming("guard-x.sh"));
	write("scripts/guard-x.sh", "#!/usr/bin/env bash\nexit 2\n");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "old line"], 1000);
	write("self-plugin/hooks/hooks.json", hooksNaming("guard-x.js"));
	write("scripts/guard-x.js", "");
	git(["rm", "-q", "scripts/guard-x.sh"]);
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "port"], 2000);
});

afterEach(() => {
	fs.rmSync(repo, { recursive: true, force: true });
	fs.rmSync(path.dirname(bin), { recursive: true, force: true });
	fs.rmSync(config, { recursive: true, force: true });
});

describe("keep-hook-shims.js on a real repository", () => {
	it("shims a deleted script for a session started on its line, out of git status, says so, and the shim allows", () => {
		const r = keep(1500);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("wrote hook shim scripts/guard-x.sh");
		expect(git(["status", "--porcelain"])).toBe("");
		expect(
			execFileSync(shim(), { input: '{"tool_name":"Bash"}' }).toString(),
		).toBe("");
	});

	it("removes the shim and its exclude line once every session started after the port", () => {
		keep(1500);
		const r = keep(2500);
		expect(r.stderr).toContain("removed hook shim scripts/guard-x.sh");
		expect(fs.existsSync(shim())).toBe(false);
		expect(
			fs.readFileSync(path.join(repo, ".git/info/exclude"), "utf8"),
		).not.toContain("guard-x.sh");
	});

	it("--lazy: catches a reset that deleted a script at the next commit", () => {
		const ported = git(["rev-parse", "HEAD"]).trim();
		git(["reset", "-q", "--hard", "HEAD~1"]);
		keep(2500);
		git(["reset", "-q", "--hard", ported]);
		write("README", "x");
		git(["add", "README"]);
		git(["commit", "-q", "-m", "ordinary"], 3000);
		keep(1500, repo, "--lazy");
		expect(fs.existsSync(shim())).toBe(true);
	});

	it("--lazy: prints nothing after a commit that deleted no script", () => {
		keep(2500);
		write("README", "x");
		git(["add", "README"]);
		git(["commit", "-q", "-m", "ordinary"], 3000);
		const r = keep(1500, repo, "--lazy");
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
		expect(fs.existsSync(shim())).toBe(false);
	});

	it("shims the main worktree when run from a linked one", () => {
		const linked = `${repo}-linked`;
		git(["worktree", "add", "-q", linked]);
		try {
			keep(1500, linked);
			expect(fs.existsSync(shim())).toBe(true);
		} finally {
			git(["worktree", "remove", "--force", linked]);
		}
	});

	it("refuses an unknown flag with exit 2", () => {
		expect(keep(1500, repo, "--lazzy").status).toBe(2);
		expect(fs.existsSync(shim())).toBe(false);
	});

	it("fails open, printed, where the liveness listing will not read", () => {
		fs.rmSync(path.dirname(bin), { recursive: true, force: true });
		const r = runInProcess(ENTRY, [], {
			cwd: repo,
			env: {
				...process.env,
				CLAUDE_CONFIG_DIR: config,
				WFC_CLAUDE_BIN: bin,
				WFC_ORACLE_CACHE: "0",
				WFC_OVERFLOW_ENV_ROOT: repo,
			},
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("keep-hook-shims: no shim kept or removed:");
		expect(fs.existsSync(shim())).toBe(false);
	});
});
