// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { printed, refused, stubGhRoutes } from "./lib/gh-stub";
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

const ask = (...args: string[]) => askWith({}, ...args);

const askWith = (env: Record<string, string>, ...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: repo,
		env: { ...process.env, ...env },
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

const settingsPinning = (ref: string) =>
	JSON.stringify({
		enabledPlugins: { "workflow-core@wfc": true },
		extraKnownMarketplaces: {
			wfc: { source: { source: "github", repo: "o/core", ref } },
		},
	});

const servingSettings = (settings: string) =>
	stubGhRoutes(dir, {
		"repos/o/adopter/contents/.claude/settings.json": printed(settings),
		"*": refused("gh: Not Found (HTTP 404)"),
	}).env;

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
		expect(none.out).toContain(
			"usage: node scripts/release-contains.js <sha> [--pinned-by <owner/repo>]",
		);
	});

	describe("--pinned-by reads the adopter's pin live (#5697)", () => {
		it("says met where the pinned release carries the sha", () => {
			const r = askWith(
				servingSettings(settingsPinning("v1.1.0")),
				first,
				"--pinned-by",
				"o/adopter",
			);
			expect(r.status).toBe(0);
			expect(r.out).toContain(
				`met: o/adopter pins v1.1.0, read from GitHub now, which carries ${first.slice(0, 8)}`,
			);
		});

		it("says unmet, naming the tag it saw, where the pin predates the sha", () => {
			const r = askWith(
				servingSettings(settingsPinning("v1.0.0")),
				second,
				"--pinned-by",
				"o/adopter",
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain("unmet: o/adopter pins v1.0.0");
		});

		it("fetches a pinned tag this clone lacks from its origin before judging", () => {
			const origin = path.join(dir, "origin");
			fs.mkdirSync(origin);
			gitIn(origin, "init", "-q", "--bare");
			git("remote", "add", "origin", origin);
			git("push", "-q", "origin", "HEAD:refs/heads/main", "v1.1.0");
			git("tag", "-d", "v1.1.0");
			const r = askWith(
				servingSettings(settingsPinning("v1.1.0")),
				second,
				"--pinned-by",
				"o/adopter",
			);
			expect(r.status).toBe(0);
			expect(r.out).toContain("met: o/adopter pins v1.1.0");
		});

		it.each([
			[
				"a release neither this clone nor its origin holds",
				"o/adopter",
				"v9.0.0",
				"v9.0.0 is no release tag in this clone or on its origin",
			],
			[
				"a repo GitHub does not serve",
				"o/elsewhere",
				"v1.1.0",
				"cannot read o/elsewhere's pin: GitHub did not serve its settings",
			],
		])("exits 2 on %s", (_what, adopter, ref, says) => {
			const r = askWith(
				servingSettings(settingsPinning(ref)),
				first,
				"--pinned-by",
				adopter,
			);
			expect(r.status).toBe(2);
			expect(r.out).toContain(says);
		});

		it("exits 2 on settings pinning no workflow-core ref, and on a malformed repo", () => {
			const none = askWith(
				servingSettings("{}"),
				first,
				"--pinned-by",
				"o/adopter",
			);
			expect(none.status).toBe(2);
			expect(none.out).toContain("pins no workflow-core ref");
			const bad = ask(first, "--pinned-by", "not-a-repo");
			expect(bad.status).toBe(2);
			expect(bad.out).toContain(
				"--pinned-by takes <owner/repo>, not not-a-repo",
			);
		});
	});
});
