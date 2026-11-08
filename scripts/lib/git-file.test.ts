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
import { gitFileCommonDir } from "./git-file.js";

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

describe("gitFileCommonDir (#4402)", () => {
	it("reads the registration's commondir", () => {
		fs.mkdirSync(registration, { recursive: true });
		fs.writeFileSync(
			path.join(registration, "commondir"),
			"../../../elsewhere\n",
		);

		expect(gitFileCommonDir(worktree)).toBe(
			path.join(dir, "main", "elsewhere"),
		);
	});

	it("reads a pruned registration's place under worktrees/", () => {
		expect(gitFileCommonDir(worktree)).toBe(path.join(dir, "main", ".git"));
	});

	it("is null for a .git file with no gitdir line, or a .git directory", () => {
		fs.writeFileSync(path.join(worktree, ".git"), "junk\n");
		expect(gitFileCommonDir(worktree)).toBeNull();

		const main = path.join(dir, "main");
		fs.mkdirSync(path.join(main, ".git"), { recursive: true });
		expect(gitFileCommonDir(main)).toBeNull();
	});
});
