// @vitest-environment node
/*
 * tree-members.js read from inside a commit hook, where git exports the hook
 * repo's index (#4733): another checkout is read from its own index, the
 * hook's repo from the one the commit is building.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { initGitRepo, mkScratchDir } from "./git-fixture";

const MODULE = path.join(__dirname, "tree-members.js");
const scratch = mkScratchDir("tree-members-");
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const git = (dir: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" });

/** What the adopter's pre-commit saw, its `isTreeMember` answers by name. */
function membershipInHook(): Record<string, boolean> {
	const noHooks = path.join(scratch, "no-hooks");
	const hooks = path.join(scratch, "hooks");
	const core = path.join(scratch, "core");
	const adopter = path.join(scratch, "adopter");
	const seen = path.join(scratch, "seen.json");
	fs.mkdirSync(noHooks);
	fs.mkdirSync(hooks);
	initGitRepo(core, noHooks);
	fs.writeFileSync(path.join(core, "guard.js"), "\n");
	git(core, "add", "guard.js");
	git(core, "commit", "-qm", "guard");
	const probe = `const { isTreeMember: m } = require(${JSON.stringify(MODULE)});
require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
	coreGuard: m(${JSON.stringify(core)}, "guard.js"),
	ownCommitted: m(process.cwd(), "a.md"),
	ownStagedOutsidePathspec: m(process.cwd(), "staged.md"),
}));`;
	fs.writeFileSync(path.join(scratch, "probe.js"), probe);
	fs.writeFileSync(
		path.join(hooks, "pre-commit"),
		`#!/bin/sh\nexec node ${JSON.stringify(path.join(scratch, "probe.js"))}\n`,
		{ mode: 0o755 },
	);
	initGitRepo(adopter, hooks);
	fs.writeFileSync(path.join(adopter, "staged.md"), "\n");
	git(adopter, "add", "staged.md");
	fs.writeFileSync(path.join(adopter, "a.md"), "changed\n");
	/* A pathspec commit: git builds a temporary index of HEAD plus a.md and
	 * exports it, so staged.md is in the real index but not that one. */
	git(adopter, "commit", "-qm", "pathspec", "--", "a.md");
	return JSON.parse(fs.readFileSync(seen, "utf8"));
}

describe("isTreeMember inside an adopter's pre-commit (#4733)", () => {
	const seen = membershipInHook();

	it("reads another checkout from its own index", () => {
		expect(seen.coreGuard).toBe(true);
	});

	it("reads the hook's own repo from the pathspec commit's temporary index", () => {
		expect(seen.ownCommitted).toBe(true);
		expect(seen.ownStagedOutsidePathspec).toBe(false);
	});
});
