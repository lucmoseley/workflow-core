// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baselineOf } from "./check.js";
import { readBaselineCommit } from "./citation-tracker.js";
import { commitSha, readCommit } from "./commit-sha.js";
import { gitReader } from "./git.js";
import { defineTemplate, identityRepoTemplate } from "./git-fixture";

let dir: string;

const git = (args: string[], cwd = dir) =>
	execFileSync("git", args, { encoding: "utf8", cwd }).trim();

function commitOnce() {
	fs.mkdirSync(path.join(dir, "sub"));
	fs.writeFileSync(path.join(dir, "sub", "a.txt"), "1");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "base"]);
	return git(["rev-parse", "HEAD"]);
}

const configuredRepo = defineTemplate(identityRepoTemplate);

beforeEach(() => {
	dir = configuredRepo.instantiate(
		fs.mkdtempSync(path.join(os.tmpdir(), "commit-sha-")),
	);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("commitSha", () => {
	it("answers the full sha for a commit, by ref or by short sha", () => {
		const sha = commitOnce();
		expect(commitSha(dir, "HEAD")).toBe(sha);
		expect(commitSha(dir, sha.slice(0, 7))).toBe(sha);
		expect(commitSha(dir, "main")).toBe(sha);
	});

	it("answers from a root below the repository's top", () => {
		const sha = commitOnce();
		expect(commitSha(path.join(dir, "sub"), "HEAD")).toBe(sha);
	});

	it("answers null for a tree, a blob or an unknown rev", () => {
		commitOnce();
		expect(commitSha(dir, "HEAD^{tree}")).toBeNull();
		expect(commitSha(dir, "HEAD:sub/a.txt")).toBeNull();
		expect(commitSha(dir, "no-such-ref")).toBeNull();
	});

	it("asks through an injected exec, so a caller's stub answers it", () => {
		const sha = "a".repeat(40);
		const stub = (_file: string, args: string[]) => {
			if (args.includes("seen^{commit}")) return `${sha}\n`;
			if (args.includes("gone^{commit}"))
				throw Object.assign(new Error("exit 1"), { status: 1 });
			return "not-a-sha\n";
		};
		expect(commitSha(dir, "seen", stub)).toBe(sha);
		expect(commitSha(dir, "other", stub)).toBeNull();
		expect(commitSha(dir, "gone", stub)).toBeNull();
	});

	it("answers null for an unborn HEAD and outside a repository", () => {
		expect(commitSha(dir, "HEAD")).toBeNull();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "commit-sha-out-"));
		try {
			expect(commitSha(outside, "HEAD")).toBeNull();
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("readCommit (#2864, #3068)", () => {
	it("answers the sha for a commit, and null for an unborn HEAD or an unknown rev", () => {
		expect(readCommit(gitReader(dir), "HEAD")).toEqual({
			ok: true,
			sha: null,
		});
		const sha = commitOnce();
		expect(readCommit(gitReader(dir), "HEAD")).toEqual({ ok: true, sha });
		expect(readCommit(gitReader(dir), "no-such-ref")).toEqual({
			ok: true,
			sha: null,
		});
	});

	it("answers ok: false outside a repository and where git will not run, which a checker reads as BROKEN", () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "commit-sha-out-"));
		try {
			expect(readCommit(gitReader(outside), "HEAD").ok).toBe(false);
			vi.stubEnv("WFC_GIT", path.join(outside, "no-such-git"));
			expect(readCommit(gitReader(dir), "HEAD").ok).toBe(false);
			const exitsOne = path.join(outside, "git");
			fs.writeFileSync(exitsOne, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
			vi.stubEnv("WFC_GIT", exitsOne);
			expect(readCommit(gitReader(dir), "HEAD").ok).toBe(false);
			expect(readBaselineCommit(gitReader(dir), "HEAD").ok).toBe(false);
			expect(commitSha(dir, "HEAD")).toBeNull();
			expect(() => baselineOf("HEAD")).toThrow(/would not resolve HEAD/);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});
