// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { stampFile, stampVariable } from "./lib/commit-key.js";
import { fixture, reason, temps } from "./lib/precommit-test-stamp-testkit";

it("runs the declared test inside the hook, the lock held, where no stamp is named", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const r = f.commit();
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
	expect(r.out).toContain(reason("no stamp named"));
});

it("exits 2 where the worktree runner crashes before the suite's verdict (#3808)", () => {
	const f = fixture();
	fs.writeFileSync(
		path.join(f.root, "scripts/lib/isolated-worktree.js"),
		"process.exit(7);\n",
	);
	f.stage("a.txt", "changed\n");
	const r = f.runHook();
	expect(r.stderr).toContain(
		"scripts/lib/isolated-worktree.js failed (exit 7) before the suite gave a verdict",
	);
	expect(r.stderr).toContain("commit again once it runs");
	expect(r.status).toBe(2);
});

it("stands the test down on a stamp matching the commit's changes, and the commit lands", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const stamp = f.stamp();
	const r = f.commit(stamp);
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual([]);
	expect(fs.existsSync(stamp)).toBe(true);
});

it("runs the test in the lock on a matching stamp outside the hook's git directory, saying so", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "test-stamp-out-"));
	temps.push(outside);
	const r = f.commit(f.stamp(path.join(outside, "stamp")));
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
	expect(r.out).toContain(
		reason("stamp unreadable or outside this checkout's git directory"),
	);
});

it("runs the test in the lock on a matching stamp in a linked worktree's git directory, saying so", () => {
	const f = fixture();
	f.git("worktree", "add", "-q", "--detach", path.join(f.root, ".wt"));
	f.stage("a.txt", "changed\n");
	const sibling = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
		cwd: path.join(f.root, ".wt"),
		encoding: "utf8",
	}).trim();
	const r = f.commit(f.stamp(path.join(sibling, "stamp")));
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
	expect(r.out).toContain(
		reason("stamp unreadable or outside this checkout's git directory"),
	);
});

it("runs the test in the lock on a stamp naming no file, saying so", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const r = f.commit(path.join(f.gitDir, "no-such-stamp"));
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
	expect(r.out).toContain(
		reason("stamp unreadable or outside this checkout's git directory"),
	);
});

it("runs the test in the lock on a stamp whose key does not match, saying so, and keeps the variable from it", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const stamp = f.stamp();
	f.stage("a.txt", "changed again\n");
	const r = f.commit(stamp);
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
	expect(r.out).toContain(reason("changes that do not match"));
});

it("does not match a commit differing from the stamp's only by a deletion", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const stamp = f.stamp();
	f.stage("b.txt", null);
	const r = f.commit(stamp);
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt,b.txt"]);
	expect(r.out).toContain(reason("changes that do not match"));
});

it("does not match a commit differing from the stamp's only by a mode change", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const stamp = f.stamp();
	fs.chmodSync(path.join(f.root, "a.txt"), 0o755);
	const r = f.commit(stamp);
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
	expect(r.out).toContain(reason("changes that do not match"));
});

it("runs the test in the lock on another gate's stamp matching the commit's changes (#1904)", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const r = f.commit(
		f.stamp(path.join(f.gitDir, "wfc-1.mutation-stamp"), "mutation"),
	);
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
	expect(r.out).toContain(reason("changes that do not match"));
});

it("lets a second gate write and read a stamp of its own, the test gate's untouched (#1904)", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const run = "wfc-1";
	const testStamp = f.stamp(stampFile("test", f.gitDir, run));
	const testKey = fs.readFileSync(testStamp, "utf8");
	const mutationStamp = f.stamp(
		stampFile("mutation", f.gitDir, run),
		"mutation",
	);
	expect(mutationStamp).not.toBe(testStamp);
	expect(stampVariable("test")).toBe("WFC_TEST_STAMP");
	expect(stampVariable("mutation")).not.toBe(stampVariable("test"));
	expect(f.standDown("mutation", mutationStamp).status).toBe(0);
	expect(f.standDown("test", testStamp).status).toBe(0);
	expect(fs.readFileSync(testStamp, "utf8")).toBe(testKey);
	const crossed = f.standDown("test", mutationStamp);
	expect(crossed.status).toBe(1);
	expect(crossed.stdout).toBe("changes that do not match\n");
});

it("stands down on an unborn branch's first commit with a matching stamp", () => {
	const f = fixture({ born: false });
	f.stage("a.txt", "first\n");
	const r = f.commit(f.stamp());
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual([]);
});

it("applies the same rule on the --no-verify route, through prepare-commit-msg", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const stood = f.commit(f.stamp(), "--no-verify");
	expect(stood.landed).toBe(true);
	expect(stood.runs).toEqual([]);

	f.stage("a.txt", "changed again\n");
	const ran = f.commit(undefined, "--no-verify");
	expect(ran.landed).toBe(true);
	expect(ran.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
});
