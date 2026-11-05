// @vitest-environment node
/*
 * lib/pull-form-host.js (#2797): each production read the guard-pull-form core's
 * core asks of git and the landing config,
 * answered by a real throwaway repo, in process. What the core does with
 * each answer is lib/pull-form.test.ts's.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initGitRepo, mkScratchDir } from "./git-fixture";

const { buildHostPorts } = require("./pull-form-host.js") as {
	buildHostPorts: (root: string) => {
		pullFf: (dir: string) => string;
		currentBranch: (dir: string) => string;
		isCommit: (dir: string, word: string) => boolean;
	};
};

let dir: string;
let repo: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(() => {
	dir = mkScratchDir("pull-form-host-");
	repo = path.join(dir, "repo");
	fs.mkdirSync(path.join(dir, "no-hooks"));
	initGitRepo(repo, path.join(dir, "no-hooks"));
	vi.stubEnv("WFC_MODULES", undefined);
	vi.stubEnv("CLAUDE_PROJECT_DIR", path.join(dir, "elsewhere"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const ports = () => buildHostPorts(repo);

describe("the git reads", () => {
	it("reads pull.ff, and answers empty where it is unset or git cannot answer", () => {
		expect(ports().pullFf(repo)).toBe("");
		git("config", "pull.ff", "only");
		expect(ports().pullFf(repo)).toBe("only");
		expect(ports().pullFf(path.join(dir, "no-hooks"))).toBe("");
	});

	it("names the checked-out branch short, and nothing when detached", () => {
		expect(ports().currentBranch(repo)).toBe("main");
		git("checkout", "-q", "--detach");
		expect(ports().currentBranch(repo)).toBe("");
	});

	it("tells a commit from a tree and from a path", () => {
		const tree = git("rev-parse", "HEAD^{tree}");
		const p = ports();
		expect([
			p.isCommit(repo, "HEAD"),
			p.isCommit(repo, tree),
			p.isCommit(repo, "a.md"),
		]).toEqual([true, false, false]);
	});
});
