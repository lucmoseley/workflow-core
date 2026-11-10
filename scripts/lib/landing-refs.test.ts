// @vitest-environment node
/*
 * Pins the one choice of which remote ref the "what has been pushed" readers
 * read (#2408, #4458): with the `landing` module on, a session worktree's own
 * `origin/queue/<name>` where it stands, else `origin/main`; `origin/main`
 * with the module off or on a config that will not read. Every pushed reader
 * calls it, so a wrong answer moves push coverage, the unpushed count and
 * commit-ledger status onto a ref the session does not push to.
 *
 * A throwaway host per test, never this one, since this checkout's own config
 * is what the answer turns on.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInProcess } from "./run-in-process";

const { ownQueueRef, pushedRef, readUnpushedRef } =
	createRequire(__filename)("./landing-refs.js");
const SCRIPT = path.join(__dirname, "landing-refs.js");

let root: string;

/** A host declaring `modules` in its config, or `raw` as the file's bytes. */
function host(modules: string[] | null, raw?: string) {
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude/workflow-core.json"),
		raw ?? JSON.stringify({ contract: 1, modules }),
	);
}

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "landing-")));
	vi.stubEnv("WFC_MODULES", undefined);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

/** Run git in `cwd`, quietly. */
const gitIn = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, stdio: "ignore" });

/** A one-commit repository at `root`, and a session worktree of it. */
function sessionWorktree(name: string) {
	gitIn(root, "init", "-q", "-b", "main");
	gitIn(
		root,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"c",
	);
	const tree = path.join(root, ".claude", "worktrees", name);
	gitIn(root, "worktree", "add", "-q", "--detach", tree);
	return tree;
}

describe("pushedRef", () => {
	it("is a session worktree's own queue ref once it stands, with the landing module on", () => {
		host(["suites", "landing"]);
		const tree = sessionWorktree("fix-it");
		gitIn(root, "update-ref", "refs/remotes/origin/queue/fix-it", "HEAD");
		expect(pushedRef({ root, tree })).toBe("origin/queue/fix-it");
	});

	it("is origin/main for a session worktree whose queue ref does not stand", () => {
		host(["suites", "landing"]);
		const tree = sessionWorktree("fix-it");
		gitIn(root, "update-ref", "refs/remotes/origin/queue/other", "HEAD");
		expect(pushedRef({ root, tree })).toBe("origin/main");
	});

	it("names the queue ref a land pushes for a symlinked path to the worktree", () => {
		host(["suites", "landing"]);
		const tree = sessionWorktree("fix-it");
		gitIn(root, "update-ref", "refs/remotes/origin/queue/fix-it", "HEAD");
		const link = `${root}-link`;
		fs.symlinkSync(root, link);
		try {
			expect(
				pushedRef({
					root,
					tree: path.join(link, ".claude", "worktrees", "fix-it"),
				}),
			).toBe("origin/queue/fix-it");
			expect(pushedRef({ root: link, tree })).toBe("origin/queue/fix-it");
		} finally {
			fs.rmSync(link);
		}
	});

	it("reads the tree's host's config where no root is named (#4692)", () => {
		host(["suites", "landing"]);
		const tree = sessionWorktree("fix-it");
		fs.mkdirSync(path.join(tree, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(tree, ".claude/workflow-core.json"),
			JSON.stringify({ contract: 1, modules: ["suites"] }),
		);
		gitIn(root, "update-ref", "refs/remotes/origin/queue/fix-it", "HEAD");
		expect(pushedRef({ tree })).toBe("origin/queue/fix-it");
	});

	it("is origin/main for the host itself, with the module on", () => {
		host(["suites", "landing"]);
		expect(pushedRef({ root })).toBe("origin/main");
		expect(pushedRef({ root, tree: root })).toBe("origin/main");
	});

	it("is origin/main where the module is off, the queue ref standing", () => {
		host(["suites"]);
		const tree = sessionWorktree("fix-it");
		gitIn(root, "update-ref", "refs/remotes/origin/queue/fix-it", "HEAD");
		expect(pushedRef({ root, tree })).toBe("origin/main");
	});

	it("is origin/main where the config will not read", () => {
		host(null, "{ not json");
		expect(pushedRef({ root })).toBe("origin/main");
	});
});

describe("readUnpushedRef", () => {
	/** A checkout at `root` on `branch`, whose upstream is `upstream` if any. */
	function checkout(branch: string, upstream?: string) {
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, stdio: "ignore" });
		git("init", "-q", "-b", branch);
		git(
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"c",
		);
		if (!upstream) return;
		git("remote", "add", "origin", root);
		git("update-ref", `refs/remotes/${upstream}`, "HEAD");
		git("config", `branch.${branch}.remote`, "origin");
		git(
			"config",
			`branch.${branch}.merge`,
			`refs/heads/${upstream.slice("origin/".length)}`,
		);
	}

	it("is a spike branch's own upstream, whatever the module", () => {
		host(["landing"]);
		checkout("spike/x", "origin/spike/x");
		expect(readUnpushedRef({ root })).toBe("origin/spike/x");
	});

	it("is the pushed ref in a session worktree, its own queue ref", () => {
		host(["landing"]);
		const tree = sessionWorktree("fix-it");
		gitIn(root, "update-ref", "refs/remotes/origin/queue/fix-it", "HEAD");
		expect(readUnpushedRef({ root, tree })).toBe("origin/queue/fix-it");
	});

	it("is the pushed ref on a branch with no upstream", () => {
		host(["suites"]);
		checkout("wip");
		expect(readUnpushedRef({ root })).toBe("origin/main");
	});
});

describe("ownQueueRef", () => {
	it("names a worktree under the host's .claude/worktrees by its directory", () => {
		expect(
			ownQueueRef(path.join("/h", ".claude", "worktrees", "fix-it"), "/h"),
		).toBe("queue/fix-it");
	});

	it("names no queue ref for the host itself or a tree elsewhere", () => {
		expect(ownQueueRef("/h", "/h")).toBeNull();
		expect(ownQueueRef("/elsewhere/.claude/worktrees/x", "/h")).toBeNull();
		expect(ownQueueRef(null, "/h")).toBeNull();
	});

	/* #4856: every caller asks here, so a host or tree reached through a
	 * symlink names the one ref a land pushes. */
	it("names the same ref through a symlinked host or tree", () => {
		const tree = path.join(root, ".claude", "worktrees", "fix-it");
		fs.mkdirSync(tree, { recursive: true });
		const linkedHost = `${root}-host`;
		const linkedTree = `${root}-tree`;
		fs.symlinkSync(root, linkedHost);
		fs.symlinkSync(tree, linkedTree);
		try {
			expect(ownQueueRef(tree, linkedHost)).toBe("queue/fix-it");
			expect(ownQueueRef(linkedTree, root)).toBe("queue/fix-it");
		} finally {
			fs.rmSync(linkedHost);
			fs.rmSync(linkedTree);
		}
	});
});

describe("the CLI", () => {
	const cli = (args: string[]) =>
		runInProcess(SCRIPT, args, { cwd: root, env: { ...process.env } });

	it("prints the pushed ref for the host it is named, main with landing on", () => {
		host(["landing"]);
		const r = cli(["pushed", root]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("origin/main\n");
	});

	it("prints the pushed ref's branch for a workflow, main with landing on", () => {
		host(["landing"]);
		const r = cli(["pushed-branch", root]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("main\n");
	});

	it("reads the host's config for a linked worktree, not the worktree's own copy (#4692)", () => {
		host(["suites", "landing"]);
		const tree = sessionWorktree("fix-it");
		fs.mkdirSync(path.join(tree, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(tree, ".claude/workflow-core.json"),
			JSON.stringify({ contract: 1, modules: ["suites"] }),
		);
		gitIn(root, "update-ref", "refs/remotes/origin/queue/fix-it", "HEAD");
		for (const [verb, out] of [
			["pushed", "origin/queue/fix-it"],
			["unpushed", "origin/queue/fix-it"],
			["pushed-branch", "queue/fix-it"],
		]) {
			const r = cli([verb, tree]);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe(`${out}\n`);
		}
	});

	it("fails the pushed branch on a config that will not read, never naming main", () => {
		host(null, "{ not json");
		const r = cli(["pushed-branch", root]);
		expect(r.status).not.toBe(0);
		expect(r.stdout).toBe("");
	});

	it("refuses anything else with its usage", () => {
		const r = cli(["verified"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			"usage: landing-refs.js pushed|unpushed|pushed-branch [<tree>]",
		);
	});
});
