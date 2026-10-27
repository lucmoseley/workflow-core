import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { readAdopterCheckouts, discoverRepos } = require("./refill-repos.js");

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

	it("excludes a checkout whose config cannot be read, naming why", () => {
		const root = checkout("broken", {});
		fs.writeFileSync(path.join(root, ".claude", "workflow-core.json"), "{");
		const found = discoverRepos(home);
		expect(found.included).toEqual([]);
		expect(found.excluded[0].root).toBe(root);
		expect(found.excluded[0].why).toContain("does not parse");
	});

	it("keeps out a checkout whose refillLoop is malformed, since its owner meant to opt out", () => {
		const root = checkout("typo", { refillLoop: "false" });
		expect(discoverRepos(home)).toEqual({
			included: [],
			excluded: [{ root, why: '"refillLoop" is not a boolean' }],
		});
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
