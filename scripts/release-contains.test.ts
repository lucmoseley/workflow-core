// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	defineTemplate,
	identityRepoTemplate,
	mkScratchDir,
} from "./lib/git-fixture";
import { buildReleaseMessage } from "./lib/release-tags.js";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "release-contains.js");

let dir: string;
let repo: string;

const gitIn = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const git = (...args: string[]) => gitIn(repo, ...args);

const commitIn = (cwd: string, name: string) => {
	fs.writeFileSync(path.join(cwd, name), name);
	gitIn(cwd, "add", name);
	gitIn(cwd, "commit", "-qm", name);
	return gitIn(cwd, "rev-parse", "HEAD");
};

const cutIn = (cwd: string, tag: string, message: string) => {
	const tree = gitIn(cwd, "write-tree");
	gitIn(cwd, "tag", tag, gitIn(cwd, "commit-tree", tree, "-m", message));
};
const cut = (tag: string, message: string) => cutIn(repo, tag, message);

const released = defineTemplate((root) => {
	const at = path.join(root, "repo");
	fs.mkdirSync(at);
	identityRepoTemplate(at);
	gitIn(at, "config", "core.hooksPath", path.join(root, "no-hooks"));

	cutIn(at, "v0.9.0", "Release demo v0.9.0");
	const a = commitIn(at, "a");
	cutIn(at, "v1.0.0", buildReleaseMessage("demo", "v1.0.0", a));
	const b = commitIn(at, "b");
	cutIn(at, "v1.1.0", buildReleaseMessage("demo", "v1.1.0", b));
	commitIn(at, "c");
});

const ask = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, { cwd: repo });
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

let first: string;
let second: string;
let unreleased: string;

beforeEach(() => {
	dir = released.instantiate(mkScratchDir("release-contains-test-"));
	repo = path.join(dir, "repo");
	first = git("rev-parse", "HEAD~2");
	second = git("rev-parse", "HEAD~1");
	unreleased = git("rev-parse", "HEAD");
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
		cut("v1.2.0", buildReleaseMessage("demo", "v1.2.0", "f".repeat(40)));
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
