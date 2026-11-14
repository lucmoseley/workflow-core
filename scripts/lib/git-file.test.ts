// @vitest-environment node
/*
 * lib/git-file.js against `.git` files written in the test's temp directory.
 * Broken, a hold raised on a worktree git will not answer for splits from its
 * checkout's store (#4402), and a loop's worktree whose registration went
 * reads as registered, never registered again (#5209).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readGitFileCommonDir,
	readRegisteredTree,
	readRegistrationFault,
	readRegistrations,
	registrationGate,
} from "./git-file.js";

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

describe("a common dir's registrations (#4880)", () => {
	const common = () => path.join(dir, "main", ".git");

	it("lists each registration and reads the worktree its gitdir names", () => {
		fs.mkdirSync(registration, { recursive: true });
		fs.writeFileSync(
			path.join(registration, "gitdir"),
			`${path.join(worktree, ".git")}\n`,
		);

		expect(readRegistrations(common())).toEqual([registration]);
		expect(readRegisteredTree(registration)).toBe(worktree);
	});

	it("is empty with no worktrees/ directory, and null where gitdir is gone", () => {
		expect(readRegistrations(common())).toEqual([]);
		expect(readRegisteredTree(registration)).toBeNull();
	});
});

describe("readRegistrationFault (#5209)", () => {
	const nameBack = (tree: string) => {
		fs.mkdirSync(registration, { recursive: true });
		fs.writeFileSync(
			path.join(registration, "gitdir"),
			`${path.join(tree, ".git")}\n`,
		);
	};

	it("is null for a registration naming the worktree back, and a main checkout", () => {
		nameBack(worktree);
		const main = path.join(dir, "main");

		expect(readRegistrationFault(worktree)).toBeNull();
		expect(readRegistrationFault(main)).toBeNull();
	});

	it("names a registration gone, or taken by another worktree", () => {
		expect(readRegistrationFault(worktree)).toBe(
			`its registration ${registration} is gone`,
		);
		const other = path.join(dir, "other");
		fs.mkdirSync(other);
		fs.writeFileSync(path.join(other, ".git"), `gitdir: ${registration}\n`);
		nameBack(other);
		expect(readRegistrationFault(worktree)).toBe(
			`its registration ${registration} names ${other}`,
		);
	});

	it("names a .git file naming nothing, and passes a directory with none", () => {
		fs.writeFileSync(path.join(worktree, ".git"), "nonsense\n");
		expect(readRegistrationFault(worktree)).toMatch(/names no registration$/);
		fs.rmSync(path.join(worktree, ".git"));
		expect(readRegistrationFault(worktree)).toBeNull();
	});

	it("names a .git file that will not read, never throwing", () => {
		fs.chmodSync(path.join(worktree, ".git"), 0o000);

		expect(readRegistrationFault(worktree)).toMatch(
			new RegExp(`^${path.join(worktree, ".git")} will not read: EACCES`),
		);
	});
});

describe("registrationGate (#5209)", () => {
	it("says a fault once until it changes, and passes once registered", () => {
		const said: string[] = [];
		const reads = registrationGate(worktree, (fault) => said.push(fault));

		expect([reads(), reads()]).toEqual([false, false]);
		fs.writeFileSync(path.join(worktree, ".git"), "nonsense\n");
		expect(reads()).toBe(false);
		fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${registration}\n`);
		fs.mkdirSync(registration, { recursive: true });
		fs.writeFileSync(
			path.join(registration, "gitdir"),
			`${path.join(worktree, ".git")}\n`,
		);
		expect(reads()).toBe(true);
		expect(said).toEqual([
			`its registration ${registration} is gone`,
			`${path.join(worktree, ".git")} names no registration`,
		]);
	});
});
