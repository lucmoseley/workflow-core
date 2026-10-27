// @vitest-environment node
/*
 * Pins the shared commit probes (#2090): a full sha for a commit, null for
 * anything else, from any directory in the work tree; and readCommit's
 * `ok: false` where git would not answer (#2864). Every check that asks
 * whether a rev is a commit reads it, so a loosened case lets one of them
 * diff against a tree or a ref the clone never fetched.
 *
 * A throwaway repo per test, never this one: a parallel session moves HEAD.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const probe: any = createRequire(__filename)("./commit-sha.js");

let dir: string;

const git = (args: string[]) =>
	execFileSync("git", args, { encoding: "utf8", cwd: dir }).trim();

function commitOnce() {
	fs.mkdirSync(path.join(dir, "sub"));
	fs.writeFileSync(path.join(dir, "sub", "a.txt"), "1");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "base"]);
	return git(["rev-parse", "HEAD"]);
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "commit-sha-"));
	git(["init", "-q", "-b", "main"]);
	git(["config", "user.email", "t@example.invalid"]);
	git(["config", "user.name", "Test"]);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("commitSha", () => {
	it("answers the full sha for a commit, by ref or by short sha", () => {
		const sha = commitOnce();
		expect(probe.commitSha(dir, "HEAD")).toBe(sha);
		expect(probe.commitSha(dir, sha.slice(0, 7))).toBe(sha);
		expect(probe.isCommit(dir, "main")).toBe(true);
	});

	it("answers from a root below the repository's top", () => {
		const sha = commitOnce();
		expect(probe.commitSha(path.join(dir, "sub"), "HEAD")).toBe(sha);
	});

	it("answers null for a tree, a blob or an unknown rev", () => {
		commitOnce();
		expect(probe.commitSha(dir, "HEAD^{tree}")).toBeNull();
		expect(probe.commitSha(dir, "HEAD:sub/a.txt")).toBeNull();
		expect(probe.isCommit(dir, "no-such-ref")).toBe(false);
	});

	it("asks through an injected exec, so a caller's stub answers it", () => {
		const sha = "a".repeat(40);
		const stub = (_file: string, args: string[]) =>
			args.includes("seen^{commit}") ? `${sha}\n` : "not-a-sha\n";
		expect(probe.commitSha(dir, "seen", stub)).toBe(sha);
		expect(probe.commitSha(dir, "other", stub)).toBeNull();
	});

	it("answers null for an unborn HEAD and outside a repository", () => {
		expect(probe.isCommit(dir, "HEAD")).toBe(false);
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "commit-sha-out-"));
		try {
			expect(probe.isCommit(outside, "HEAD")).toBe(false);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("readCommit (#2864)", () => {
	it("answers the sha for a commit, and null for an unborn HEAD or an unknown rev", () => {
		expect(probe.readCommit(dir, "HEAD")).toEqual({ ok: true, sha: null });
		const sha = commitOnce();
		expect(probe.readCommit(dir, "HEAD")).toEqual({ ok: true, sha });
		expect(probe.readCommit(dir, "no-such-ref")).toEqual({
			ok: true,
			sha: null,
		});
	});

	it("answers ok: false outside a repository and where git will not run", () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "commit-sha-out-"));
		const saved = process.env.WFC_GIT;
		try {
			expect(probe.readCommit(outside, "HEAD").ok).toBe(false);
			process.env.WFC_GIT = path.join(outside, "no-such-git");
			expect(probe.readCommit(dir, "HEAD").ok).toBe(false);
			const exitsOne = path.join(outside, "git");
			fs.writeFileSync(exitsOne, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
			process.env.WFC_GIT = exitsOne;
			expect(probe.readCommit(dir, "HEAD").ok).toBe(false);
		} finally {
			if (saved === undefined) delete process.env.WFC_GIT;
			else process.env.WFC_GIT = saved;
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});
