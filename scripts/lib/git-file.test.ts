// @vitest-environment node
/*
 * lib/git-file.js against `.git` files written in the test's temp directory.
 * Broken, a hold raised on a worktree git will not answer for splits from its
 * checkout's store (#4402).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGitFileCommonDir } from "./git-file.js";

let dir: string;
let worktree: string;
let registration: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-file-"));
	worktree = path.join(dir, "wt");
	registration = path.join(dir, "main", ".git", "worktrees", "wt");
	fs.mkdirSync(worktree);
	fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${registration}\n`);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("readGitFileCommonDir (#4402)", () => {
	it("reads the registration's commondir", () => {
		fs.mkdirSync(registration, { recursive: true });
		fs.writeFileSync(
			path.join(registration, "commondir"),
			"../../../elsewhere\n",
		);

		expect(readGitFileCommonDir(worktree)).toBe(
			path.join(dir, "main", "elsewhere"),
		);
	});

	it("reads a pruned registration's place under worktrees/", () => {
		expect(readGitFileCommonDir(worktree)).toBe(path.join(dir, "main", ".git"));
	});

	it("is null for a .git file with no gitdir line, or a .git directory", () => {
		fs.writeFileSync(path.join(worktree, ".git"), "junk\n");
		expect(readGitFileCommonDir(worktree)).toBeNull();

		const main = path.join(dir, "main");
		fs.mkdirSync(path.join(main, ".git"), { recursive: true });
		expect(readGitFileCommonDir(main)).toBeNull();
	});

	it("throws where the .git file is there but will not read", () => {
		fs.chmodSync(path.join(worktree, ".git"), 0o000);

		expect(() => readGitFileCommonDir(worktree)).toThrow(/EACCES/);
	});
});
