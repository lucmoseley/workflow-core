// @vitest-environment node
/*
 * scripts/lander.js end to end on a culprit whose revert conflicts (#3932,
 * #3935, #4452), against lib/lander-testkit.ts's real-git sandbox.
 *
 * Loosen it and a red merge or an anchors-file conflict holds the queue on a
 * batch the lander could have cleared, or lands a revert that drops a row
 * `landing` moved since, or one whose regenerated file reads stale.
 *
 * Over the 10 s file budget: six of its nine cases are real lander runs that
 * bisect and revert, ~100–170 forks a run and a registry check (#4301's
 * profile); #4480 brings it under.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRevertLine, whyNotLanderRevert } from "./lib/clean-revert.js";
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
import { render } from "./lib/read-edges-render.js";

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

describe("a culprit whose revert conflicts in a regenerated file (#4452)", () => {
	const Manifest = "docs/test-read-edges.json";

	/** A commit adding `<name>.txt` and a test reading it, the manifest rendered. */
	const commitReadBy = (name: string) => {
		fs.writeFileSync(
			path.join(work, `${name}.test.ts`),
			`const ROOT = path.resolve(__dirname, "..");\nfs.readFileSync(path.join(ROOT, "${name}.txt"));\n`,
		);
		fs.writeFileSync(path.join(work, `${name}.txt`), name);
		fs.mkdirSync(path.join(work, "docs"), { recursive: true });
		fs.writeFileSync(path.join(work, Manifest), render(work).text);
		return commit(name);
	};

	/** On `base`, a red commit then a later one, both moving the manifest. */
	const commitRedThenLater = () => {
		const base = commitReadBy("base");
		const red = commitReadBy("red");
		const tip = commitReadBy("later");
		return { base, red, tip };
	};

	it("reverts it and lands, the file as its generator renders it on the revert's tree", async () => {
		const { base, red, tip } = commitRedThenLater();
		git(work, "push", "-q", "origin", `${base}:main`, `${tip}:landing`);
		const { gh } = stubTracker();
		const r = await runLander(stubRedWhile("red"), "landing", gh.env);

		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain(`revert ${red} on landing`);
		const landed = git(remote, "rev-parse", "main");
		expect(git(remote, "rev-parse", "landing")).toBe(landed);
		expect(git(remote, "log", "-1", "--format=%b", landed)).toContain(
			`Conflicts in ${Manifest} regenerated on the revert's tree by scripts/generate-test-read-edges.js`,
		);
		git(work, "fetch", "-q", "origin");
		const edges = JSON.parse(git(work, "show", `${landed}:${Manifest}`)).edges;
		expect(Object.keys(edges)).toEqual(["base.txt", "later.txt"]);
		expect(`${git(work, "show", `${landed}:${Manifest}`)}\n`).toBe(
			render(work, { at: landed }).text,
		);
		expect(
			whyNotLanderRevert(work, { culprit: red, sha: landed, tip }),
		).toBeNull();
	});

	it("settles a conflict in an anchors file and the manifest together, rendering on the anchors kept", () => {
		const Anchors = "scripts/instruction-surface-anchors.json";
		const writeAnchors = (row: string, far: string) => {
			fs.mkdirSync(path.join(work, "scripts"), { recursive: true });
			fs.writeFileSync(
				path.join(work, Anchors),
				`${JSON.stringify({ row, b: 0, c: 0, d: 0, e: 0, f: 0, far }, null, "\t")}\n`,
			);
		};
		writeAnchors("seed", "seed");
		commitReadBy("base");
		writeAnchors("culprit", "culprit");
		const red = commitReadBy("red");
		writeAnchors("later", "culprit");
		const tip = commitReadBy("later");
		git(work, "push", "-q", "origin", `${tip}:landing`);

		const made = remoteGit(work).revertOnLanding(red, null, "why");

		expect(made).toMatchObject({ sha: expect.any(String) });
		const sha = "sha" in made ? made.sha : "";
		git(work, "fetch", "-q", "origin");
		expect(JSON.parse(git(work, "show", `${sha}:${Anchors}`))).toMatchObject({
			row: "later",
			far: "seed",
		});
		expect(`${git(work, "show", `${sha}:${Manifest}`)}\n`).toBe(
			render(work, { at: sha }).text,
		);
		expect(whyNotLanderRevert(work, { culprit: red, sha, tip })).toBeNull();
	});

	it("refuses a revert whose regenerated file is not its generator's output", () => {
		const { red, tip } = commitRedThenLater();
		expect(() => git(work, "revert", "--no-commit", red)).toThrow();
		expect(git(work, "diff", "--name-only", "--diff-filter=U")).toBe(Manifest);
		git(work, "checkout", "--ours", "--", Manifest);
		git(work, "add", "--", Manifest);
		git(
			work,
			"-c",
			"user.email=t@t",
			"-c",
			"user.name=t",
			"commit",
			"-qm",
			`Revert "red"\n\n${buildRevertLine(red)}`,
		);
		const sha = git(work, "rev-parse", "HEAD");

		expect(whyNotLanderRevert(work, { culprit: red, sha, tip })).toBe(
			`its tree is not the clean revert of ${red} on ${tip}`,
		);
	});
});
