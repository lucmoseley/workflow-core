// @vitest-environment node
/*
 * scripts/lander.js end to end on a culprit whose revert conflicts (#3932,
 * #3935, #4453), against lib/lander-testkit.ts's real-git sandbox.
 *
 * Loosen it and a red merge, an anchors-file conflict or a later commit
 * conflicting with the revert holds the queue on a batch the lander could have
 * cleared, or lands a revert that drops a row `landing` moved since; loosen
 * the cap or the dependents' own reverts and it reverts past what it can
 * name.
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

	/** Whether reverting `merge` against `parent` on `work`'s HEAD conflicts. */
	const revertConflicts = (merge: string, parent: string) => {
		try {
			git(
				work,
				"merge-tree",
				"--write-tree",
				`--merge-base=${merge}`,
				"HEAD",
				parent,
			);
			return false;
		} catch {
			return true;
		}
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
		expect(revertConflicts(merge, m)).toBe(true);

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
		expect(revertConflicts(merge, m)).toBe(true);

		const { gh } = stubTracker();
		const r = await runLander(stubRedWhile("red"), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain(`revert ${red} on landing`);
		expectRedRevertedAndLanded();
	});

	it("reverts the merge with the later commit its revert conflicts with, where a merge on the side adds nothing the bisected parent lacks (#3936, #4453)", async () => {
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
		expect(r.stdout).toContain(`revert ${merge} on landing`);
		expect(r.stdout).toMatch(
			new RegExp(`file-fix-ticket ${merge}, reverted in \\w+ with ${tip}`),
		);
		const landed = git(remote, "rev-parse", "main");
		expect(git(remote, "rev-parse", "landing")).toBe(landed);
		const files = git(remote, "ls-tree", "--name-only", landed).split("\n");
		expect(files).not.toContain("side.txt");
		expect(files).not.toContain("tip.txt");
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

	it("reverts the later commit with it, and lands, where the revert conflicts in another file too (#4453)", async () => {
		const { red, tip } = pushRedSide(() =>
			fs.writeFileSync(path.join(work, "shared.txt"), "later\n"),
		);
		const { gh } = stubTracker();
		const r = await runLander(stubRedWhile("red"), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toMatch(
			new RegExp(`file-fix-ticket ${red}, reverted in \\w+ with ${tip}`),
		);
		const landed = git(remote, "rev-parse", "main");
		expect(git(remote, "rev-parse", "landing")).toBe(landed);
		expect(git(remote, "show", `${landed}:shared.txt`)).toBe("seed");
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

describe("a culprit whose revert conflicts in a hand-written file (#4453)", () => {
	const writeShared = (text: string) =>
		fs.writeFileSync(path.join(work, "shared.txt"), `${text}\n`);

	/**
	 * `main` on `m`, and on `landing` the red commit editing shared.txt, then
	 * each of `later` editing it again, so the red one's revert conflicts.
	 */
	const pushRedThen = (...later: string[]) => {
		writeShared("seed");
		const m = commit("m");
		writeShared("red");
		const red = commit("red");
		const shas = later.map((name) => {
			writeShared(name);
			return commit(name);
		});
		const tip = git(work, "rev-parse", "HEAD");
		git(work, "push", "-q", "origin", `${m}:main`, `${tip}:landing`);
		return { m, red, later: shas, tip };
	};

	it("reverts the later commit with it as one push, moves main past both, and files a re-land ticket the fix ticket names", async () => {
		const { red, later } = pushRedThen("later");
		const { gh, readStore } = stubTracker();
		const r = await runLander(stubRedWhile("red"), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		const landed = git(remote, "rev-parse", "main");
		expect(git(remote, "rev-parse", "landing")).toBe(landed);
		expect(git(remote, "show", `${landed}:shared.txt`)).toBe("seed");
		const files = git(remote, "ls-tree", "--name-only", landed).split("\n");
		expect(files).not.toContain("red.txt");
		expect(files).not.toContain("later.txt");
		const reverts = git(remote, "log", "--format=%s", `${later[0]}..${landed}`);
		expect(reverts.split("\n")).toEqual(['Revert "red"', 'Revert "later"']);

		const issues: { number: number; title: string; body: string }[] =
			readStore();
		const reland = issues.find((i) =>
			i.title.startsWith(
				`Re-land ${later[0]?.slice(0, 9)}, reverted with ${red.slice(0, 9)}`,
			),
		);
		const fix = issues.find((i) =>
			i.title.startsWith(`Re-land ${red.slice(0, 9)}, reverted by the lander`),
		);
		expect(reland?.body).toContain(`Its revert conflicted with ${later[0]}`);
		expect(fix?.body).toContain(`#${reland?.number}`);
	});

	it("holds, naming the cap, where more later commits changed the conflicting files than it reverts with one culprit", async () => {
		const { m, tip } = pushRedThen("a", "b", "c", "d");
		const { gh } = stubTracker();
		const r = await runLander(stubRedWhile("red"), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain(
			"(conflicts in shared.txt); 4 later commits changed them, past the 3 the lander reverts with one culprit",
		);
		expect(git(remote, "rev-parse", "landing")).toBe(tip);
		expect(git(remote, "rev-parse", "main")).toBe(m);
	});

	it("holds, naming the later commit, where its own revert does not apply", async () => {
		writeShared("seed");
		const m = commit("m");
		writeShared("red");
		const red = commit("red");
		writeShared("d");
		const d = commit("d");
		git(work, "checkout", "-q", "--detach", red);
		writeShared("x");
		commit("x");
		try {
			git(work, "merge", "-q", "--no-edit", d);
		} catch {
			/* shared.txt conflicts, settled below as the merge's own change. */
		}
		writeShared("resolved");
		const tip = commit("resolved");
		git(work, "push", "-q", "origin", `${m}:main`, `${tip}:landing`);

		const { gh } = stubTracker();
		const r = await runLander(stubRedWhile("red"), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain(
			"a later commit that changed them, did not apply",
		);
		expect(git(remote, "rev-parse", "landing")).toBe(tip);
		expect(git(remote, "rev-parse", "main")).toBe(m);
	});
});
