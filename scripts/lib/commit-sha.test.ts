// @vitest-environment node
/*
 * Pins the shared commit probes (#2090): a full sha for a commit, null for
 * anything else, from any directory in the work tree; and readCommit's
 * `ok: false` where git would not answer (#2864), which readBaselineCommit
 * inherits (#3068). Every check that asks
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
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const { gitReader }: any = createRequire(__filename)("./git.js");
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const { readBaselineCommit }: any = createRequire(__filename)(
	"./citation-tracker.js",
);
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const { baselineOf }: any = createRequire(__filename)("./check.js");

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
		expect(probe.commitSha(dir, "main")).toBe(sha);
	});

	it("answers from a root below the repository's top", () => {
		const sha = commitOnce();
		expect(probe.commitSha(path.join(dir, "sub"), "HEAD")).toBe(sha);
	});

	it("answers null for a tree, a blob or an unknown rev", () => {
		commitOnce();
		expect(probe.commitSha(dir, "HEAD^{tree}")).toBeNull();
		expect(probe.commitSha(dir, "HEAD:sub/a.txt")).toBeNull();
		expect(probe.commitSha(dir, "no-such-ref")).toBeNull();
	});

	it("asks through an injected exec, so a caller's stub answers it", () => {
		const sha = "a".repeat(40);
		const stub = (_file: string, args: string[]) => {
			if (args.includes("seen^{commit}")) return `${sha}\n`;
			if (args.includes("gone^{commit}"))
				throw Object.assign(new Error("exit 1"), { status: 1 });
			return "not-a-sha\n";
		};
		expect(probe.commitSha(dir, "seen", stub)).toBe(sha);
		expect(probe.commitSha(dir, "other", stub)).toBeNull();
		expect(probe.commitSha(dir, "gone", stub)).toBeNull();
	});

	it("answers null for an unborn HEAD and outside a repository", () => {
		expect(probe.commitSha(dir, "HEAD")).toBeNull();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "commit-sha-out-"));
		try {
			expect(probe.commitSha(outside, "HEAD")).toBeNull();
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("readCommit (#2864, #3068)", () => {
	it("answers the sha for a commit, and null for an unborn HEAD or an unknown rev", () => {
		expect(probe.readCommit(gitReader(dir), "HEAD")).toEqual({
			ok: true,
			sha: null,
		});
		const sha = commitOnce();
		expect(probe.readCommit(gitReader(dir), "HEAD")).toEqual({ ok: true, sha });
		expect(probe.readCommit(gitReader(dir), "no-such-ref")).toEqual({
			ok: true,
			sha: null,
		});
	});

	it("answers ok: false outside a repository and where git will not run, which a checker reads as BROKEN", () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "commit-sha-out-"));
		const saved = process.env.WFC_GIT;
		try {
			expect(probe.readCommit(gitReader(outside), "HEAD").ok).toBe(false);
			process.env.WFC_GIT = path.join(outside, "no-such-git");
			expect(probe.readCommit(gitReader(dir), "HEAD").ok).toBe(false);
			const exitsOne = path.join(outside, "git");
			fs.writeFileSync(exitsOne, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
			process.env.WFC_GIT = exitsOne;
			expect(probe.readCommit(gitReader(dir), "HEAD").ok).toBe(false);
			expect(readBaselineCommit(gitReader(dir), "HEAD").ok).toBe(false);
			expect(probe.commitSha(dir, "HEAD")).toBeNull();
			expect(() => baselineOf("HEAD")).toThrow(/would not resolve HEAD/);
		} finally {
			if (saved === undefined) delete process.env.WFC_GIT;
			else process.env.WFC_GIT = saved;
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});
