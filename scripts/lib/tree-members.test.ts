// @vitest-environment node
/*
 * tree-members.js read from inside a commit hook, where git exports the hook
 * repo's index (#4733): another checkout is read from its own index, the
 * hook's repo from the one the commit is building. A real pathspec commit
 * through a real hook, since which variables git exports, and where they
 * point, is git's to decide (a linked worktree adds GIT_DIR). Broken, an
 * adopter's registry checker calls every core guard non-existent, or a
 * pathspec commit is judged on files it does not carry.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initGitRepo, mkScratchDir } from "./git-fixture";

const MODULE = path.join(__dirname, "tree-members.js");
const scratch = mkScratchDir("tree-members-");
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const git = (dir: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" });

type Seen = Record<string, boolean>;

/** A core holding guard.js, and a pre-commit that records what it sees. */
function coreAndHooks(): { core: string; hooks: string; seen: string } {
	const noHooks = path.join(scratch, "no-hooks");
	const hooks = path.join(scratch, "hooks");
	const core = path.join(scratch, "core");
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
	return { core, hooks, seen };
}

/**
 * A pathspec commit of a.md from `checkout`, with staged.md staged beside it:
 * git builds a temporary index of HEAD plus a.md and exports it, so staged.md
 * is in the real index but not that one.
 */
function pathspecCommit(checkout: string, seen: string): Seen {
	fs.writeFileSync(path.join(checkout, "staged.md"), "\n");
	git(checkout, "add", "staged.md");
	fs.writeFileSync(path.join(checkout, "a.md"), `${checkout}\n`);
	git(checkout, "commit", "-qm", "pathspec", "--", "a.md");
	return JSON.parse(fs.readFileSync(seen, "utf8"));
}

describe("isTreeMember inside an adopter's pre-commit (#4733)", () => {
	const answers: Record<string, Seen> = {};
	beforeAll(() => {
		const { hooks, seen } = coreAndHooks();
		const adopter = path.join(scratch, "adopter");
		initGitRepo(adopter, hooks);
		answers["the main worktree"] = pathspecCommit(adopter, seen);
		const linked = path.join(scratch, "linked");
		git(adopter, "worktree", "add", "-q", "-b", "side", linked);
		answers["a linked worktree"] = pathspecCommit(linked, seen);
	});

	for (const from of ["the main worktree", "a linked worktree"]) {
		it(`reads another checkout from its own index, committing from ${from}`, () => {
			expect(answers[from].coreGuard).toBe(true);
		});

		it(`reads the hook's own repo from the pathspec commit's temporary index, committing from ${from}`, () => {
			expect(answers[from].ownCommitted).toBe(true);
			expect(answers[from].ownStagedOutsidePathspec).toBe(false);
		});
	}
});
