// @vitest-environment node
/*
 * The contract lib/git-tree-fake.js keeps with lib/git-tree.js (#2863, §G7).
 * Each case asks real git in a temp-dir layout and the fake declared over
 * that same layout, so a drift in either fails here. Breaking it costs the
 * guard cores' module suites their tie to git: they go on passing against a
 * fake that no longer answers as git does.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	defineTemplate,
	mkDirOutsideRepo,
	mkScratchDir,
	trioTemplate,
} from "./git-fixture";
import { readSymbolicName, treeClassifier } from "./git-tree.js";
import {
	fakeSymbolicName,
	fakeTreeClassifier,
	unresolvedTreeClassifier,
} from "./git-tree-fake.js";

const template = defineTemplate(trioTemplate());

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let dir: string;
let shared: string;
let wt: string;
let nested: string;
let elsewhere: string;
let broken: string;
let noRepo: string;
beforeAll(() => {
	dir = mkScratchDir("git-tree-contract-");
	template.instantiate(dir);
	shared = path.join(dir, "shared");
	wt = path.join(dir, "wt");
	elsewhere = path.join(dir, "elsewhere");
	nested = path.join(shared, ".claude", "worktrees", "nested");
	fs.mkdirSync(path.join(shared, "sub"));
	git(shared, "worktree", "add", "-q", "-b", "topic", nested);
	git(shared, "tag", "v1");
	git(shared, "branch", "both");
	git(shared, "tag", "both");
	git(wt, "checkout", "-q", "--detach");
	broken = path.join(dir, "broken-repo");
	fs.mkdirSync(broken);
	fs.writeFileSync(
		path.join(broken, ".git"),
		`gitdir: ${path.join(dir, "no-such-gitdir")}\n`,
	);
	noRepo = mkDirOutsideRepo("git-tree-contract-");
});

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(noRepo, { recursive: true, force: true });
});

describe("tree class — the fake over a declared layout", () => {
	const fake = () =>
		fakeTreeClassifier({
			[shared]: "shared",
			[wt]: "linked",
			[nested]: "linked",
			[broken]: "unknown",
			[path.join(shared, "gone")]: "other",
		});

	it.each<[string, () => string]>([
		["the shared tree", () => shared],
		["a directory in the shared tree", () => path.join(shared, "sub")],
		["a linked worktree", () => wt],
		["a worktree linked inside the shared tree", () => nested],
		["another repository", () => elsewhere],
		["a directory in no repository", () => noRepo],
		["a path with nothing at it", () => path.join(shared, "gone")],
		["a tree git cannot answer for", () => broken],
		["the empty path", () => ""],
	])("answers as treeClassifier does for %s", (_, at) => {
		expect(fake()(at())).toBe(treeClassifier(shared)(at()));
	});

	it("throws what treeClassifier throws for a host repo that does not resolve", () => {
		let real = "";
		try {
			treeClassifier(noRepo);
		} catch (e) {
			real = (e as Error).message;
		}
		expect(real).not.toBe("");
		expect(() => unresolvedTreeClassifier(noRepo)(shared)).toThrow(real);
	});
});

describe("symbolic name — the fake over a declared repository", () => {
	const fake = () =>
		fakeSymbolicName({
			root: shared,
			head: "main",
			worktrees: { [wt]: null, [nested]: "topic" },
			branches: ["both", "side"],
			tags: ["v1", "both"],
		});

	it.each<[string, () => string, () => string]>([
		["a branch", () => shared, () => "main"],
		["a tag", () => shared, () => "v1"],
		["HEAD on a branch", () => shared, () => "HEAD"],
		["HEAD from a subdirectory", () => path.join(shared, "sub"), () => "HEAD"],
		["HEAD detached", () => wt, () => "HEAD"],
		[
			"HEAD in a worktree linked inside the shared tree",
			() => nested,
			() => "HEAD",
		],
		["@", () => nested, () => "@"],
		["a full ref", () => shared, () => "refs/tags/v1"],
		["a ref by its kind", () => shared, () => "heads/main"],
		["a full ref to nothing", () => shared, () => "refs/heads/nosuch"],
		["a name that resolves to nothing", () => shared, () => "nosuch"],
		["a name both a branch and a tag", () => shared, () => "both"],
		["a sha", () => shared, () => git(shared, "rev-parse", "HEAD")],
		["a tree in no repository", () => noRepo, () => "HEAD"],
	])("answers as git rev-parse does for %s", (_, at, src) => {
		expect(fake()(at(), src())).toBe(readSymbolicName(at(), src()));
	});

	it.each(["refs/remotes/origin/main", "remotes/origin/main"])(
		"throws on %s, a ref it does not model, naming it",
		(src) => {
			expect(() => fake()(shared, src)).toThrow(src);
		},
	);
});
