// @vitest-environment node
/*
 * Over lib/dirty-tree-async.js: the async read names what the sync one does,
 * and null where git will not answer (#4542). A throwaway repo per test.
 *
 * WHAT BREAKS IF THESE GO WRONG: check-orphaned-edits.js misses a dirty
 * worktree, so its edits are lost unfiled, or files a clean one as orphaned.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const tree: any = createRequire(__filename)("./dirty-tree-async.js");

let dir: string;
const made: string[] = [];

const tmp = (prefix: string) => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	made.push(d);
	return d;
};

const git = (args: string[], cwd = dir) =>
	execFileSync("git", args, { encoding: "utf8", cwd }).trim();

beforeEach(() => {
	dir = tmp("dirty-tree-async-");
	git(["init", "-q", "-b", "main"], dir);
	git(["config", "user.email", "t@example.invalid"]);
	git(["config", "user.name", "Test"]);
	fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "base"]);
});

afterEach(() => {
	for (const d of made.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

describe("readDirtyTrackedAsync (#4542)", () => {
	it("names a rename's both paths and no untracked one", async () => {
		git(["mv", "a.txt", "b.txt"]);
		fs.writeFileSync(path.join(dir, "scratch.tmp"), "x\n");
		expect(await tree.readDirtyTrackedAsync(dir)).toEqual(["a.txt", "b.txt"]);
	});

	it("answers null where git will not answer, never an empty set", async () => {
		expect(await tree.readDirtyTrackedAsync(tmp("not-a-repo-"))).toBeNull();
	});
});
