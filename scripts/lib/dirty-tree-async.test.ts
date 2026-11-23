// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDirtyTrackedAsync } from "./dirty-tree-async.js";
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

const baseRepo = defineTemplate((at) => {
	git(["init", "-q", "-b", "main"], at);
	git(["config", "user.email", "t@example.invalid"], at);
	git(["config", "user.name", "Test"], at);
	fs.writeFileSync(path.join(at, "a.txt"), "one\n");
	git(["add", "-A"], at);
	git(["commit", "-q", "-m", "base"], at);
});

beforeEach(() => {
	dir = baseRepo.instantiate(tmp("dirty-tree-async-"));
});

afterEach(() => {
	for (const d of made.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

describe("readDirtyTrackedAsync (#4542)", () => {
	it("names a rename's both paths and no untracked one", async () => {
		git(["mv", "a.txt", "b.txt"]);
		fs.writeFileSync(path.join(dir, "scratch.tmp"), "x\n");
		expect(await readDirtyTrackedAsync(dir)).toEqual(["a.txt", "b.txt"]);
	});

	it("answers null where git will not answer, never an empty set", async () => {
		expect(await readDirtyTrackedAsync(tmp("not-a-repo-"))).toBeNull();
	});
});
