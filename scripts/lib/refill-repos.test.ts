import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const {
	readAdopterCheckouts,
	readCheckoutTracking,
	discoverRepos,
	readAbsence,
} = require("./refill-repos.js");

let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "refill-home-"));
});
afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

/** A checkout under the fixture home; `git` "file" makes a linked worktree. */
function checkout(
	name: string,
	config: Record<string, unknown> | null,
	git: "dir" | "file" = "dir",
) {
	const root = path.join(home, name);
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	if (git === "dir") fs.mkdirSync(path.join(root, ".git"));
	else fs.writeFileSync(path.join(root, ".git"), "gitdir: elsewhere\n");
	if (config)
		fs.writeFileSync(
			path.join(root, ".claude", "workflow-core.json"),
			JSON.stringify({ contract: 1, ...config }),
		);
	return root;
}

describe("discoverRepos (#2003)", () => {
	it("includes the five repos, excludes fantasy-books on its flag, and skips a linked worktree and a checkout with no config", () => {
		const included = [
			"design-vault",
			"health-and-fitness",
			"mantahostels",
			"mmm-infra",
			"workflow-core",
		].map((n) => checkout(n, {}));
		const books = checkout("fantasy-books", { refillLoop: false });
		const worktree = checkout("design-vault-proto-26", {}, "file");
		checkout("no-config", null);

		const found = discoverRepos(home);
		expect(found.included.sort()).toEqual(included.sort());
		expect(found.excluded).toEqual(
			expect.arrayContaining([
				{ root: books, why: "refillLoop: false" },
				{ root: worktree, why: "not a main checkout" },
			]),
		);
		expect(found.excluded).toHaveLength(2);
	});

	it("names a checkout whose config cannot be read as a fault, not an exclusion", () => {
		const root = checkout("broken", {});
		fs.writeFileSync(path.join(root, ".claude", "workflow-core.json"), "{");
		const found = discoverRepos(home);
		expect(found.included).toEqual([]);
		expect(found.excluded).toEqual([]);
		expect(found.faulted[0].root).toBe(root);
		expect(found.faulted[0].why).toContain("does not parse");
	});

	it("keeps out a checkout whose refillLoop is malformed, since its owner meant to opt out, naming it as a fault", () => {
		const root = checkout("typo", { refillLoop: "false" });
		expect(discoverRepos(home)).toEqual({
			included: [],
			excluded: [],
			faulted: [{ root, why: '"refillLoop" is not a boolean' }],
		});
	});
});

describe("readAbsence (#3835)", () => {
	it("carries a checkout with no config or no .git, and ends one whose directory is gone", () => {
		const noConfig = checkout("no-config", null);
		const noGit = checkout("no-git", {});
		fs.rmSync(path.join(noGit, ".git"), { recursive: true });

		expect(readAbsence(noConfig)).toEqual({
			carried: true,
			why: "no workflow-core config",
		});
		expect(readAbsence(noGit)).toEqual({ carried: true, why: "no .git" });
		expect(readAbsence(path.join(home, "gone"))).toEqual({
			carried: false,
			why: "directory gone",
		});
	});

	it("reads a plain file where the directory was as gone", () => {
		const root = path.join(home, "now-a-file");
		fs.writeFileSync(root, "");
		expect(readAbsence(root)).toEqual({
			carried: false,
			why: "directory gone",
		});
	});

	it("gives nothing for a linked worktree, with or without a config, or one its owner opted out", () => {
		expect(readAbsence(checkout("worktree", {}, "file"))).toBeNull();
		expect(readAbsence(checkout("bare-worktree", null, "file"))).toBeNull();
		expect(
			readAbsence(checkout("opted-out", { refillLoop: false })),
		).toBeNull();
	});

	it("gives nothing for a checkout whole enough for discovery", () => {
		expect(readAbsence(checkout("whole", {}))).toBeNull();
	});

	it("gives nothing for one its owner opted out, its .git missing too", () => {
		const root = checkout("opted-out", { refillLoop: false });
		fs.rmSync(path.join(root, ".git"), { recursive: true });
		expect(readAbsence(root)).toBeNull();
	});
});

describe("readAdopterCheckouts (#2121)", () => {
	it("returns fantasy-books, which discoverRepos leaves out on its refillLoop flag, and skips a linked worktree and a checkout with no config", () => {
		const core = checkout("workflow-core", {});
		const books = checkout("fantasy-books", { refillLoop: false });
		const worktree = checkout("workflow-core-wt", {}, "file");
		checkout("no-config", null);

		const found = readAdopterCheckouts(home);
		expect(found.included.sort()).toEqual([books, core].sort());
		expect(found.excluded).toEqual([
			{ root: worktree, why: "not a main checkout" },
		]);
		expect(discoverRepos(home).included).toEqual([core]);
	});
});

describe("readCheckoutTracking (#3487)", () => {
	const breakConfig = (root: string) =>
		fs.writeFileSync(
			path.join(root, ".claude", "workflow-core.json"),
			"{ nope",
		);

	it("finds the checkout past a neighbour whose config will not read", () => {
		breakConfig(checkout("aaa", {}));
		const theirs = checkout("zzz", { tracker: "owner/theirs" });
		expect(readCheckoutTracking("owner/theirs", home)).toEqual({
			root: theirs,
		});
	});

	it("names that neighbour where nothing tracks the repo", () => {
		const broken = checkout("aaa", {});
		breakConfig(broken);
		const { why } = readCheckoutTracking("owner/nobody", home);
		expect(why).toContain(`no checkout under ${home} tracks owner/nobody`);
		expect(why).toContain(`and ${broken} (`);
	});
});
