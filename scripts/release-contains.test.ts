// @vitest-environment node
/*
 * Pins release-contains.js's answer to which releases carry a commit: every
 * release naming it, main-only past the last release, a tag it cannot judge
 * named, and exit 2 where it cannot ask (#797).
 *
 * The fixture cuts releases as release-plugin.js does — root commits made with
 * `git commit-tree`, off every branch, carrying its own `releaseMessage` — so
 * `git tag --contains` answers nothing here too, the trap #791 fell into (#797).
 *
 * A session or the founder runs it by hand (`docs/agents/adopter-upgrade.md`):
 * loosen a case and it tells them a fix has shipped to adopters when it has
 * not, or the reverse.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkScratchDir } from "./lib/git-fixture";
import { releaseMessage } from "./lib/release-tags.js";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "release-contains.js");

let dir: string;
let repo: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const commit = (name: string) => {
	fs.writeFileSync(path.join(repo, name), name);
	git("add", name);
	git("commit", "-qm", name);
	return git("rev-parse", "HEAD");
};

const cut = (tag: string, message: string) => {
	const tree = git("write-tree");
	git("tag", tag, git("commit-tree", tree, "-m", message));
};

const ask = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, { cwd: repo });
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

let first: string;
let second: string;
let unreleased: string;

beforeEach(() => {
	dir = mkScratchDir("release-contains-test-");
	repo = path.join(dir, "repo");
	execFileSync("git", ["init", "-q", "-b", "main", repo]);
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	git("config", "core.hooksPath", path.join(dir, "no-hooks"));

	cut("v0.9.0", "Release demo v0.9.0");
	first = commit("a");
	cut("v1.0.0", releaseMessage("demo", "v1.0.0", first));
	second = commit("b");
	cut("v1.1.0", releaseMessage("demo", "v1.1.0", second));
	unreleased = commit("c");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("release-contains", () => {
	it("names every release carrying a sha and the first, where --contains finds none", () => {
		expect(git("tag", "--contains", first)).toBe("");
		const r = ask(first.slice(0, 8));
		expect(r.status).toBe(0);
		expect(r.out).toContain("carried by v1.0.0, v1.1.0");
		expect(r.out).toContain("first release carrying it: v1.0.0");
	});

	it("says plainly when only main carries the sha, past the last release", () => {
		const r = ask(unreleased);
		expect(r.status).toBe(1);
		expect(r.out).toContain(`No release carries ${unreleased.slice(0, 8)}`);
	});

	it("names a tag whose message carries no rendered-from line", () => {
		const r = ask(second);
		expect(r.status).toBe(0);
		expect(r.out).toContain("first release carrying it: v1.1.0");
		expect(r.out).toContain(
			"unread: v0.9.0: its message carries no rendered-from line",
		);
	});

	it("names a tag whose source this clone lacks", () => {
		cut("v1.2.0", releaseMessage("demo", "v1.2.0", "f".repeat(40)));
		const r = ask(unreleased);
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			`unread: v1.2.0: its source ${"f".repeat(40)} is not in this clone`,
		);
	});

	it("refuses a sha naming no commit, and a missing argument, with exit 2", () => {
		const bad = ask("deadbeef");
		expect(bad.status).toBe(2);
		expect(bad.out).toContain("deadbeef names no commit in this clone");
		const none = ask();
		expect(none.status).toBe(2);
		expect(none.out).toContain("usage: node scripts/release-contains.js <sha>");
	});
});
