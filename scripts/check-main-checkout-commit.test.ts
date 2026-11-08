// @vitest-environment node
/*
 * The pre-commit limb that refuses a commit in a cut-over main checkout
 * (#4248), run where .husky/pre-commit runs it: at the committing tree's top,
 * in a real main checkout and a linked worktree of it.
 *
 * Loosen it and a commit lands on the main checkout's `main` that the
 * levelling step's fast-forward cannot keep.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-main-checkout-commit.js");

let tmp: string;
let main: string;
let worktree: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

const run = (cwd: string, env: Record<string, string> = {}) =>
	runInProcess(SCRIPT, [], {
		cwd,
		env: { ...process.env, WFC_MODULES: "landing", ...env },
	});

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcc-")));
	main = path.join(tmp, "main");
	worktree = path.join(tmp, "wt");
	git(tmp, "init", "-q", "-b", "main", main);
	git(main, "config", "user.email", "t@t");
	git(main, "config", "user.name", "t");
	git(main, "commit", "-q", "--allow-empty", "-m", "seed");
	git(main, "update-ref", "refs/remotes/origin/main", "HEAD");
	git(main, "worktree", "add", "-q", "--detach", worktree);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

it("refuses a commit in a cut-over main checkout, naming the worktree route", () => {
	const r = run(main);
	expect(r.status).toBe(1);
	expect(r.stdout + r.stderr).toContain("which takes no commits");
	expect(r.stdout + r.stderr).toContain("session-checkout.js cut");
});

it("passes in a linked worktree", () => {
	expect(run(worktree).status).toBe(0);
});

it("passes a main checkout not yet cut over, its main tracking landing", () => {
	git(main, "config", "branch.main.merge", "refs/heads/landing");
	expect(run(main).status).toBe(0);
});

it("passes with the `landing` module off, and on the founder's escape", () => {
	expect(run(main, { WFC_MODULES: "" }).status).toBe(0);
	expect(run(main, { WFC_ALLOW_BRANCH: "1" }).status).toBe(0);
});

it("passes where no origin/main exists yet: the commit that starts a new repo's main (#2412)", () => {
	git(main, "update-ref", "-d", "refs/remotes/origin/main");
	const r = run(main);
	expect(r.status, r.stdout + r.stderr).toBe(0);
	expect(r.stdout + r.stderr).toContain("this commit starts main");
});
