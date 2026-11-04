// @vitest-environment node
/*
 * scripts/lander.js end to end on a culprit whose revert conflicts (#3932,
 * #3935), against lib/lander-testkit.ts's real-git sandbox.
 *
 * Loosen it and a red merge or an anchors-file conflict holds the queue on a
 * batch the lander could have cleared, or lands a revert that drops a row
 * `landing` moved since.
 *
 * Over the 10 s file budget: five of its six cases are real lander runs that
 * bisect and revert, ~100–170 forks a run and a registry check (#4301's
 * profile); #4326 cuts the script's own forks.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { remoteGit } from "./lib/lander.js";
import {
	commit,
	git,
	landerSandbox,
	remote,
	runLander,
	stubRedWhile,
	stubTracker,
	work,
} from "./lib/lander-testkit";

landerSandbox();

describe("a culprit merge whose own revert conflicts (#3932)", () => {
	const editShared = (line: string) => {
		fs.writeFileSync(path.join(work, "shared.txt"), `${line}\n`);
		return commit(line);
	};

	/**
	 * `main` on `m`, and on `landing` a merge of `side` into `m` with a tip
	 * editing a file the side added, so reverting the merge conflicts.
	 */
	const pushMergeOf = (side: string, m: string) => {
		git(work, "checkout", "-q", "--detach", m);
		git(work, "merge", "-q", "--no-edit", side);
		const merge = git(work, "rev-parse", "HEAD");
		const tip = editShared("tip");
		git(work, "push", "-q", "origin", `${m}:main`, `${tip}:landing`);
		return { merge, tip };
	};

	const expectRedRevertedAndLanded = () => {
		const landed = git(remote, "rev-parse", "main");
		expect(git(remote, "rev-parse", "landing")).toBe(landed);
		expect(git(remote, "log", "-1", "--format=%s", landed)).toBe(
			'Revert "red"',
		);
		const files = git(remote, "ls-tree", "--name-only", landed).split("\n");
		expect(files).not.toContain("red.txt");
		expect(files).toContain("shared.txt");
	};

	it("reverts the side commit behind the side's own reconcile merge, and lands the batch", async () => {
		const seed = git(work, "rev-parse", "HEAD");
		const m = commit("m");
		git(work, "checkout", "-q", "--detach", seed);
		const red = commit("red");
		editShared("side");
		git(work, "merge", "-q", "--no-edit", m);
		const side = git(work, "rev-parse", "HEAD");
		const { merge } = pushMergeOf(side, m);
		expect(remoteGit(work).revertOnLanding(merge, m, "why")).toEqual({
			failed: expect.stringContaining("(conflicts in shared.txt)"),
		});

		const { gh } = stubTracker();
		const r = await runLander(stubRedWhile("red"), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain(`revert ${red} on landing`);
		expectRedRevertedAndLanded();
	});

	it("reverts the commit a merge on the side brought in, and lands the batch (#3936)", async () => {
		const seed = git(work, "rev-parse", "HEAD");
		const m = commit("m");
		git(work, "checkout", "-q", "--detach", seed);
		const red = commit("red");
		git(work, "checkout", "-q", "--detach", seed);
		editShared("side");
		git(work, "merge", "-q", "--no-edit", red);
		const side = git(work, "rev-parse", "HEAD");
		const { merge } = pushMergeOf(side, m);
		expect(remoteGit(work).revertOnLanding(merge, m, "why")).toEqual({
			failed: expect.stringContaining("(conflicts in shared.txt)"),
		});

		const { gh } = stubTracker();
		const r = await runLander(stubRedWhile("red"), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain(`revert ${red} on landing`);
		expectRedRevertedAndLanded();
	});

	it("holds, naming the conflict and the merge the search ended at, where a merge on the side adds nothing the bisected parent lacks (#3936)", async () => {
		const seed = git(work, "rev-parse", "HEAD");
		const m = commit("m");
		const main = commit("main");
		git(work, "checkout", "-q", "--detach", seed);
		editShared("side");
		git(work, "merge", "-q", "--no-edit", m);
		const side = git(work, "rev-parse", "HEAD");
		const { merge, tip } = pushMergeOf(side, main);

		const { gh } = stubTracker();
		const r = await runLander(stubRedWhile("m", "side"), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain(
			`the revert of ${merge.slice(0, 9)} did not land`,
		);
		expect(r.stdout).toContain("(conflicts in shared.txt)");
		expect(r.stdout).toContain(
			`no commit on its merged side to revert instead: its first red commit ${side.slice(0, 9)} is itself a merge with nothing further to search`,
		);
		expect(git(remote, "rev-parse", "landing")).toBe(tip);
		expect(git(remote, "rev-parse", "main")).toBe(main);
	});
});

describe("a culprit whose revert conflicts in an anchors file (#3935)", () => {
	const Anchors = "scripts/instruction-surface-anchors.json";
	const writeAnchors = (row: string, far: string) => {
		fs.mkdirSync(path.join(work, "scripts"), { recursive: true });
		fs.writeFileSync(
			path.join(work, Anchors),
			`${JSON.stringify({ row, b: 0, c: 0, d: 0, e: 0, f: 0, far }, null, "\t")}\n`,
		);
	};

	/**
	 * `main` on `m`, and on `landing` a merge of a red side commit moving two
	 * far-apart rows, then `then` and a later commit moving the first row again,
	 * so that side commit's revert conflicts on the first row alone.
	 */
	const pushRedSide = (then?: () => void) => {
		writeAnchors("seed", "seed");
		fs.writeFileSync(path.join(work, "shared.txt"), "seed\n");
		const base = commit("base");
		const m = commit("m");
		git(work, "checkout", "-q", "--detach", base);
		writeAnchors("culprit", "culprit");
		fs.writeFileSync(path.join(work, "shared.txt"), "culprit\n");
		const red = commit("red");
		git(work, "checkout", "-q", "--detach", m);
		git(work, "merge", "-q", "--no-edit", red);
		writeAnchors("later", "culprit");
		then?.();
		const tip = commit("later");
		git(work, "push", "-q", "origin", `${m}:main`, `${tip}:landing`);
		return { m, red, tip };
	};

	it("reverts it and lands, each conflicted hunk keeping landing's side and the rest of the file reverted", async () => {
		const { red } = pushRedSide();
		const { gh } = stubTracker();
		const r = await runLander(stubRedWhile("red"), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain(`revert ${red} on landing`);
		const landed = git(remote, "rev-parse", "main");
		expect(git(remote, "rev-parse", "landing")).toBe(landed);
		expect(git(remote, "log", "-1", "--format=%s", landed)).toBe(
			'Revert "red"',
		);
		expect(git(remote, "log", "-1", "--format=%b", landed)).toContain(
			`Conflicts in ${Anchors} kept this branch's side`,
		);
		const files = git(remote, "ls-tree", "--name-only", landed).split("\n");
		expect(files).not.toContain("red.txt");
		expect(git(remote, "show", `${landed}:shared.txt`)).toBe("seed");
		expect(
			JSON.parse(git(remote, "show", `${landed}:${Anchors}`)),
		).toMatchObject({ row: "later", far: "seed" });
	});

	it("holds, naming the files, where the revert conflicts in another file too", async () => {
		const { m, tip } = pushRedSide(() =>
			fs.writeFileSync(path.join(work, "shared.txt"), "later\n"),
		);
		const { gh } = stubTracker();
		const r = await runLander(stubRedWhile("red"), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain(`(conflicts in ${Anchors}, shared.txt)`);
		expect(git(remote, "rev-parse", "landing")).toBe(tip);
		expect(git(remote, "rev-parse", "main")).toBe(m);
	});

	it("fails, naming the file, where the culprit touched only the anchors file, as keeping its hunks reverts nothing", () => {
		writeAnchors("seed", "seed");
		commit("base");
		writeAnchors("culprit", "seed");
		git(work, "commit", "-qam", "only anchors");
		const culprit = git(work, "rev-parse", "HEAD");
		writeAnchors("later", "seed");
		git(work, "commit", "-qam", "later");
		const tip = git(work, "rev-parse", "HEAD");
		git(work, "push", "-q", "origin", `${tip}:landing`);

		expect(remoteGit(work).revertOnLanding(culprit, null, "why")).toEqual({
			failed: expect.stringContaining(`(conflicts in ${Anchors})`),
		});
		expect(git(remote, "rev-parse", "landing")).toBe(tip);
	});
});
