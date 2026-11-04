// @vitest-environment node
/*
 * lib/lander.js's remoteGit against a real bare remote and clone (#2996,
 * #3123, #3913, #4171): the production git adapter scripts/lander.js wires,
 * crossed for real in lib/lander-testkit.ts's sandbox.
 *
 * Loosen it and a bisect walks a session's side of a reconcile merge, a
 * revert lands twice, or a revert's refused or hung commit loses its reason,
 * leaves its worktree behind or orphans its hook's children.
 *
 * Over the 10 s file budget: each revert spawns the guard-registry check
 * (#4326 cuts it), and the timeout case crosses the real clock.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { remoteGit } from "./lander.js";
import {
	commit,
	git,
	landerSandbox,
	remote,
	tmp,
	work,
} from "./lander-testkit";
import { isDead, waitFor } from "./process-fixture.js";
import { shellQuote } from "./sh-quote.js";

landerSandbox();

it("takes a revert already on landing as landed rather than reverting twice, reading the rows it left stale, as a retried push finds one (#2673, #3127)", () => {
	const culprit = commit("bad");
	git(work, "push", "-q", "origin", "HEAD:landing");
	git(work, "revert", "--no-edit", culprit);
	const revert = git(work, "rev-parse", "HEAD");
	git(work, "push", "-q", "origin", "HEAD:landing");

	const made = remoteGit(work).revertOnLanding(culprit, null, "why");

	expect(made).toEqual({ sha: revert, onto: culprit, stale: [] });
	expect(git(remote, "rev-parse", "landing")).toBe(revert);
});

/** A commit on `landing` to revert, with `body` as prepare-commit-msg. */
const culpritWithCommitHook = (body: string) => {
	const culprit = commit("bad");
	git(work, "push", "-q", "origin", "HEAD:landing");
	const hooks = path.join(tmp, "hooks");
	fs.mkdirSync(hooks);
	fs.writeFileSync(
		path.join(hooks, "prepare-commit-msg"),
		`#!/bin/sh\n${body}\n`,
	);
	fs.chmodSync(path.join(hooks, "prepare-commit-msg"), 0o755);
	git(work, "config", "core.hooksPath", hooks);
	return culprit;
};

it("fails a revert whose commit prepare-commit-msg refuses, naming the gate's verdict and pushing nothing (#3123)", () => {
	const culprit = culpritWithCommitHook(
		"echo '> workflow-core@0.1.0 check:staged' >&2\necho 'FAIL: 1 fault(s) this commit adds' >&2\nexit 1",
	);

	const made = remoteGit(work).revertOnLanding(culprit, null, "why");

	expect(made).toEqual({
		failed: "its commit was refused: FAIL: 1 fault(s) this commit adds",
	});
	expect(git(remote, "rev-parse", "landing")).toBe(culprit);
});

it("kills a revert's commit at its timeout as timed out, not refused, naming what it last printed, killing the hook's child, letting its trap clean up and taking the worktree off (#3913, #3916, #3923)", () => {
	const pidFile = path.join(tmp, "child-pid");
	const marker = path.join(tmp, "gate-temp");
	fs.writeFileSync(marker, "");
	const culprit = culpritWithCommitHook(
		`trap ${shellQuote(`rm -f ${shellQuote(marker)}`)} EXIT\ntrap 'exit 143' TERM\n(while :; do touch still-writing; sleep 0.1; done) >/dev/null 2>&1 &\necho $! > ${shellQuote(pidFile)}\necho '> workflow-core@0.1.0 check:staged' >&2\necho 'second gate running' >&2\nsleep 60`,
	);

	/* Crosses the real clock: only a real kill gives git's error its ETIMEDOUT
	 * and the stderr up to the kill, and what is pinned is a real signal to a
	 * real process tree. The foreground sleep holds the trap until the group's
	 * TERM reaches it. Untraced: 3 s is room for git to start the hook, its
	 * traps and its child. */
	const made = remoteGit(work, 3000).revertOnLanding(culprit, null, "why");

	expect(made).toEqual({
		failed:
			"its commit timed out after 3 s, last printing: second gate running",
	});
	expect(git(remote, "rev-parse", "landing")).toBe(culprit);
	const child = Number(fs.readFileSync(pidFile, "utf8"));
	expect(waitFor(() => isDead(child))).toBe(true);
	expect(fs.existsSync(marker)).toBe(false);
	expect(git(work, "worktree", "list").split("\n")).toHaveLength(1);
});

it("keeps the failure's reason and says so where the revert's worktree will not come off (#3913)", () => {
	const named = path.join(tmp, "worktree-path");
	const culprit = culpritWithCommitHook(
		`git rev-parse --show-toplevel > ${shellQuote(named)}\ngit worktree lock "$(cat ${shellQuote(named)})"\necho 'FAIL: 1 fault(s) this commit adds' >&2\nexit 1`,
	);
	const writeSync = fs.writeSync;
	let printed = "";
	const spied = vi.spyOn(fs, "writeSync").mockImplementation(((
		fd: number,
		data: Buffer,
		...rest: []
	) => {
		if (fd !== 2) return writeSync(fd, data, ...rest);
		printed += data.toString();
		return data.length;
	}) as typeof fs.writeSync);

	const made = remoteGit(work).revertOnLanding(culprit, null, "why");

	const dir = fs.readFileSync(named, "utf8").trim();
	spied.mockRestore();
	git(work, "worktree", "remove", "--force", "--force", dir);
	expect(made).toEqual({
		failed: "its commit was refused: FAIL: 1 fault(s) this commit adds",
	});
	expect(printed).toContain(
		`lander: could not remove the revert's worktree ${dir}`,
	);
});

/**
 * A reconcile merge pushed to landing: the session's side `s` as its first
 * parent, `l` (which main holds) as its second, then `tip` on top.
 */
const reconcileMerge = () => {
	const seed = git(work, "rev-parse", "HEAD");
	const l = commit("l");
	git(work, "push", "-q", "origin", "HEAD:main", "HEAD:landing");
	git(work, "checkout", "-q", "--detach", seed);
	const s = commit("s");
	git(work, "merge", "-q", "--no-edit", l);
	const merge = git(work, "rev-parse", "HEAD");
	const tip = commit("tip");
	git(work, "push", "-q", "origin", "HEAD:landing");
	return { l, s, merge, tip };
};

it("bisects a reconcile merge's range along the parent main precedes, never the session's side (#2996)", () => {
	const { l, s, merge, tip } = reconcileMerge();

	const chain = remoteGit(work).chain(l, tip);

	expect(chain).toEqual([merge, tip]);
	expect(chain).not.toContain(s);
});

it("bisects a range with no main along first parents from the root (#2996)", () => {
	const { l, s, merge, tip } = reconcileMerge();

	const chain = remoteGit(work).chain(null, tip);

	expect(chain.slice(-3)).toEqual([s, merge, tip]);
	expect(chain).not.toContain(l);
});

it("refuses a range whose base the tip does not descend from (#2996)", () => {
	const { l, tip } = reconcileMerge();
	git(work, "checkout", "-q", "--detach", l);
	const other = commit("other");

	expect(() => remoteGit(work).chain(other, tip)).toThrow(
		"does not descend from",
	);
});

it("reads a merge's other side from where it forks, and none for a plain commit or a parent the merge lacks (#3631)", () => {
	const { l, s, merge, tip } = reconcileMerge();
	const seed = git(work, "rev-parse", `${s}^`);

	expect(remoteGit(work).mergedSide(merge, l)).toEqual({
		base: seed,
		range: [s],
		merges: [],
	});
	expect(remoteGit(work).mergedSide(tip, merge)).toBeNull();
	expect(remoteGit(work).mergedSide(merge, tip)).toBeNull();
});

it("reads a side that reconciled with landing past its merges, stopping at what the parent holds (#3932)", () => {
	const seed = git(work, "rev-parse", "HEAD");
	const l1 = commit("l1");
	const l2 = commit("l2");
	git(work, "checkout", "-q", "--detach", seed);
	const red = commit("red");
	git(work, "merge", "-q", "--no-edit", l1);
	const inner = git(work, "rev-parse", "HEAD");
	const last = commit("last");
	git(work, "merge", "-q", "--no-edit", l2);
	const merge = git(work, "rev-parse", "HEAD");

	expect(remoteGit(work).mergedSide(merge, l2)).toEqual({
		base: seed,
		range: [red, inner, last],
		merges: [inner],
	});
});

it("reads a merge on a side down its other parent, leaving out what the bisected parent holds, and none where that is everything (#3936)", () => {
	const seed = git(work, "rev-parse", "HEAD");
	const held = commit("held");
	git(work, "checkout", "-q", "--detach", seed);
	const first = commit("first");
	git(work, "merge", "-q", "--no-edit", held);
	const adds = git(work, "rev-parse", "HEAD");
	git(work, "checkout", "-q", "--detach", first);
	const brought = commit("brought");
	git(work, "merge", "-q", "--no-edit", adds);
	const inner = git(work, "rev-parse", "HEAD");

	expect(remoteGit(work).mergedSide(inner, brought, held)).toEqual({
		base: first,
		range: [adds],
		merges: [adds],
	});
	expect(remoteGit(work).mergedSide(adds, first, held)).toBeNull();
});

describe("a culprit whose revert moves the guard registry's anchors (#4171)", () => {
	const Registry = ".claude/guard-registry-anchors.json";
	const writeRegistry = (rows: Record<string, string>) => {
		fs.mkdirSync(path.join(work, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(work, Registry),
			`${JSON.stringify(rows, null, "\t")}\n`,
		);
	};

	/** A culprit moving row `a` and adding the next row `b`, then a later commit moving `a` again. */
	const pushRedThenLater = () => {
		writeRegistry({ a: "seed", z: "seed" });
		commit("base");
		writeRegistry({ a: "culprit", b: "culprit", z: "seed" });
		const red = commit("red");
		writeRegistry({ a: "later", b: "culprit", z: "seed" });
		const tip = commit("later");
		git(work, "push", "-q", "origin", `${tip}:landing`);
		return { red, tip };
	};

	const expectRevertedPerRow = (sha: string) => {
		expect(git(remote, "show", `${sha}:${Registry}`)).toBe(
			JSON.stringify({ a: "later", z: "seed" }, null, "\t"),
		);
		expect(
			git(remote, "ls-tree", "--name-only", sha).split("\n"),
		).not.toContain("red.txt");
	};

	it("settles its conflict per row where git defines no driver, reverting the row the culprit added beside the one kept", () => {
		const { red } = pushRedThenLater();

		const made = remoteGit(work).revertOnLanding(red, null, "why");

		if (!("sha" in made)) throw new Error(made.failed);
		expectRevertedPerRow(made.sha);
		expect(git(remote, "log", "-1", "--format=%b", made.sha)).toContain(
			`Conflicts in ${Registry} kept this branch's side`,
		);
	});

	it("reverts with no conflict to the same bytes where the driver is defined", () => {
		const { red } = pushRedThenLater();
		fs.writeFileSync(
			path.join(work, ".git", "info", "attributes"),
			`${Registry} merge=registry-anchors\n`,
		);
		git(
			work,
			"config",
			"merge.registry-anchors.driver",
			`node ${shellQuote(path.resolve(__dirname, "../merge-registry-anchors.js"))} %O %A %B`,
		);

		const made = remoteGit(work).revertOnLanding(red, null, "why");

		if (!("sha" in made)) throw new Error(made.failed);
		expectRevertedPerRow(made.sha);
		expect(git(remote, "log", "-1", "--format=%b", made.sha)).not.toContain(
			"Conflicts in",
		);
	});
});

it("reverts a merge culprit against the parent the bisect stepped from, undoing the session's side (#2996)", () => {
	const { l, merge } = reconcileMerge();

	const made = remoteGit(work).revertOnLanding(merge, l, "why");

	if (!("sha" in made)) throw new Error(made.failed);
	const files = git(remote, "ls-tree", "--name-only", made.sha).split("\n");
	expect(files).toContain("l.txt");
	expect(files).not.toContain("s.txt");
});
