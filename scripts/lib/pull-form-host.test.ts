// @vitest-environment node
/*
 * lib/pull-form-host.js (#2797): each production read guard-pull-form.js's
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
	buildHostPorts: (env: { root: string }) => {
		pullFf: (dir: string) => string;
		cleanRequireForce: (dir: string) => string;
		currentBranch: (dir: string) => string;
		isCommit: (dir: string, word: string) => boolean;
		isTree: (dir: string, word: string) => boolean;
		topLevel: (dir: string) => string;
		showPrefix: (dir: string) => string;
		pushedRef: () => string;
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
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

const ports = () => buildHostPorts({ root: repo });

describe("the git reads", () => {
	it("reads pull.ff, and answers empty where it is unset or git cannot answer", () => {
		expect(ports().pullFf(repo)).toBe("");
		git("config", "pull.ff", "only");
		expect(ports().pullFf(repo)).toBe("only");
		expect(ports().pullFf(path.join(dir, "no-hooks"))).toBe("");
	});

	it("reads clean.requireForce as a boolean, as git itself does", () => {
		git("config", "clean.requireForce", "off");
		expect(ports().cleanRequireForce(repo)).toBe("false");
	});

	it("names the checked-out branch short, and nothing when detached", () => {
		expect(ports().currentBranch(repo)).toBe("main");
		git("checkout", "-q", "--detach");
		expect(ports().currentBranch(repo)).toBe("");
	});

	it("tells a commit from a tree from a path", () => {
		const tree = git("rev-parse", "HEAD^{tree}");
		const p = ports();
		expect([p.isCommit(repo, "HEAD"), p.isTree(repo, "HEAD")]).toEqual([
			true,
			true,
		]);
		expect([p.isCommit(repo, tree), p.isTree(repo, tree)]).toEqual([
			false,
			true,
		]);
		expect([p.isCommit(repo, "a.md"), p.isTree(repo, "a.md")]).toEqual([
			false,
			false,
		]);
		// A blob names an object, but not a tree.
		expect(p.isTree(repo, "HEAD:a.md")).toBe(false);
	});

	it("reads the top level and the prefix, newline off", () => {
		const sub = path.join(repo, "sub");
		fs.mkdirSync(sub);
		expect(ports().topLevel(sub)).toBe(fs.realpathSync(repo));
		expect(ports().showPrefix(sub)).toBe("sub/");
		expect(ports().showPrefix(repo)).toBe("");
	});
});

describe("the landing config", () => {
	it("names the pushed ref from the checkout's own config, not the cwd's", () => {
		expect(ports().pushedRef()).toBe("origin/main");
		fs.mkdirSync(path.join(repo, ".claude"));
		fs.writeFileSync(
			path.join(repo, ".claude", "workflow-core.json"),
			JSON.stringify({ contract: 1, modules: ["landing"] }),
		);
		expect(ports().pushedRef()).toBe("origin/landing");
	});
});
