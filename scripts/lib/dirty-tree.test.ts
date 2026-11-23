// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readDirtyTracked,
	readUntrackedEntries,
	readUntrackedFiles,
} from "./dirty-tree.js";
import { defineTemplate } from "./git-fixture";

let dir: string;
const made: string[] = [];

const tmp = (prefix: string) => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	made.push(d);
	return d;
};

const git = (args: string[], cwd = dir) =>
	execFileSync("git", args, { encoding: "utf8", cwd }).trim();

const write = (p: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
	fs.writeFileSync(path.join(dir, p), body);
};

const baseRepo = defineTemplate((at) => {
	git(["init", "-q", "-b", "main"], at);
	git(["config", "user.email", "t@example.invalid"], at);
	git(["config", "user.name", "Test"], at);
	fs.writeFileSync(path.join(at, "a.txt"), "one\n");
	git(["add", "-A"], at);
	git(["commit", "-q", "-m", "base"], at);
});

beforeEach(() => {
	dir = baseRepo.instantiate(tmp("dirty-tree-"));
});

afterEach(() => {
	for (const d of made.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

describe("readDirtyTracked", () => {
	it("names a modified tracked file and no untracked one", () => {
		write("a.txt", "two\n");
		write("scratch.tmp", "x\n");
		expect(readDirtyTracked(dir)).toEqual(["a.txt"]);
	});

	it("reads a rename's source path as well as its destination, sorted", () => {
		git(["mv", "a.txt", "b.txt"]);
		expect(readDirtyTracked(dir)).toEqual(["a.txt", "b.txt"]);
	});

	it("reads a path holding a space unquoted, so it matches a ledger entry", () => {
		write("two words.txt", "x\n");
		git(["add", "-A"]);
		git(["commit", "-q", "-m", "spaced"]);
		write("two words.txt", "y\n");
		expect(readDirtyTracked(dir)).toEqual(["two words.txt"]);
	});

	it("answers [] on a clean repo", () => {
		expect(readDirtyTracked(dir)).toEqual([]);
	});

	it("answers null where git will not answer, never an empty set", () => {
		const outside = tmp("not-a-repo-");
		expect(readDirtyTracked(outside)).toBeNull();
	});
});

describe("readUntrackedFiles", () => {
	it("names an untracked file that `readDirtyTracked`'s -uno drops", () => {
		write("new.ts", "x\n");
		expect(readUntrackedFiles(dir)).toEqual(["new.ts"]);
	});

	it("honours .gitignore, so build output is not offered as work", () => {
		write(".gitignore", "ignored/\n");
		write("ignored/out.js", "x\n");
		expect(readUntrackedFiles(dir)).toEqual([".gitignore"]);
	});

	it("answers [] where there is nothing untracked", () => {
		expect(readUntrackedFiles(dir)).toEqual([]);
	});

	it("answers null where git will not answer", () => {
		const outside = tmp("not-a-repo-");
		expect(readUntrackedFiles(outside)).toBeNull();
	});
});

describe("readUntrackedEntries", () => {
	it("collapses an untracked directory to one entry", () => {
		write("stray-dir/one.out", "x\n");
		write("stray-dir/two.out", "x\n");
		expect(readUntrackedEntries(dir)).toEqual(["stray-dir/"]);
		expect(readUntrackedFiles(dir)).toEqual([
			"stray-dir/one.out",
			"stray-dir/two.out",
		]);
	});

	it("names an untracked file and drops a modified tracked one", () => {
		write("a.txt", "two\n");
		write("scratch.out", "x\n");
		expect(readUntrackedEntries(dir)).toEqual(["scratch.out"]);
	});

	it("does not read a rename's source field as an entry", () => {
		write("?? spoof.out", "x\n");
		git(["add", "-A"]);
		git(["commit", "-q", "-m", "spoof"]);
		git(["mv", "?? spoof.out", "moved.out"]);
		expect(readUntrackedEntries(dir)).toEqual([]);
	});

	it("honours .gitignore, which is the whole of the `.claude/tmp/` exclusion", () => {
		write(".gitignore", ".claude/tmp/\n");
		write(".claude/tmp/notes.md", "x\n");
		expect(readUntrackedEntries(dir)).toEqual([".gitignore"]);
	});

	it("answers [] where there is nothing untracked", () => {
		expect(readUntrackedEntries(dir)).toEqual([]);
	});

	it("answers null where git will not answer, never an empty set", () => {
		const outside = tmp("not-a-repo-");
		expect(readUntrackedEntries(outside)).toBeNull();
	});
});
