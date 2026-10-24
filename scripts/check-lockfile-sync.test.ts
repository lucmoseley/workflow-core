// @vitest-environment node
/*
 * check-lockfile-sync.js refuses a commit whose staged lockfile is out of step
 * with its staged package.json, and prints the lockfile rule (#2029). That
 * refusal is the rule's only delivery, so a case loosened here lets a
 * dependency land without its lockfile.
 *
 * Each case commits through a real git hook in a throwaway repo: the checker
 * ends in runCheck's process exit and reads the index through git, so a spawned
 * commit is the one route that reaches it whole.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGitRepo, mkScratchDir } from "./lib/git-fixture";
import { armingPattern } from "./lib/precommit-gate-harness";

const CHECKER = "scripts/check-lockfile-sync.js";
const SCRIPT = path.join(__dirname, "check-lockfile-sync.js");
const { READS } = require("./check-lockfile-sync.js") as { READS: string[] };
const RULE = fs
	.readFileSync(
		path.join(__dirname, "..", "docs", "agents", "rules", "lockfile-sync.txt"),
		"utf8",
	)
	.trimEnd();

let dir: string;
let hooks: string;

const write = (file: string, body: unknown) =>
	fs.writeFileSync(
		path.join(dir, file),
		typeof body === "string" ? body : JSON.stringify(body),
	);

const manifest = (deps: Record<string, string>) => ({
	name: "x",
	version: "1.0.0",
	dependencies: deps,
});

/* The shape npm writes: the root entry mirrors the manifest's ranges. */
const lockfile = (deps: Record<string, string>) => ({
	name: "x",
	lockfileVersion: 3,
	requires: true,
	packages: { "": { name: "x", version: "1.0.0", dependencies: deps } },
});

const commit = (...files: string[]) => {
	const run = (...args: string[]) =>
		spawnSync("git", args, { cwd: dir, encoding: "utf8" });
	run("add", "--", ...files);
	const r = run("commit", "-qm", "c");
	return { status: r.status, out: r.stdout + r.stderr };
};

const expectRefused = (
	r: { status: number | null; out: string },
	says: string,
) => {
	expect(r.status).toBe(1);
	expect(r.out).toContain(says);
	expect(r.out).toContain(RULE);
};

beforeEach(() => {
	dir = mkScratchDir("lockfile-sync-");
	hooks = mkScratchDir("lockfile-sync-hooks-");
	fs.writeFileSync(
		path.join(hooks, "pre-commit"),
		`#!/bin/sh\nexec node ${JSON.stringify(SCRIPT)}\n`,
		{ mode: 0o755 },
	);
	initGitRepo(dir, hooks);
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(hooks, { recursive: true, force: true });
});

describe("check-lockfile-sync", () => {
	it("commits a manifest and lockfile in step, printing no rule", () => {
		write("package.json", manifest({ ms: "^2.1.3" }));
		write("package-lock.json", lockfile({ ms: "^2.1.3" }));
		const r = commit("package.json", "package-lock.json");
		expect(r.status).toBe(0);
		expect(r.out).not.toContain(RULE);
	});

	it("refuses a dependency staged without its lockfile, printing the whole rule", () => {
		write("package.json", manifest({ ms: "^2.1.3" }));
		write("package-lock.json", lockfile({ ms: "^2.1.3" }));
		expect(commit("package.json", "package-lock.json").status).toBe(0);

		write("package.json", manifest({ ms: "^2.1.3", once: "^1.4.0" }));
		expectRefused(commit("package.json"), "dependencies: once is not locked");
	});

	it.each<{ case: string; lock: Record<string, string>; says: string }>([
		{
			case: "a range the lockfile does not carry",
			lock: { ms: "^2.0.0" },
			says: "ms is ^2.1.3 in the manifest, ^2.0.0 in the lockfile",
		},
		{
			case: "a dependency locked but gone from the manifest",
			lock: { ms: "^2.1.3", once: "^1.4.0" },
			says: "once is locked but not in the manifest",
		},
	])("refuses $case", ({ lock, says }) => {
		write("package.json", manifest({ ms: "^2.1.3" }));
		write("package-lock.json", lockfile(lock));
		expectRefused(commit("package.json", "package-lock.json"), says);
	});

	it("refuses a manifest declaring dependencies with no lockfile at all", () => {
		write("package.json", manifest({ ms: "^2.1.3" }));
		expectRefused(commit("package.json"), "declares dependencies, no lockfile");
	});

	it("passes a repo that locks with another package manager", () => {
		write("package.json", manifest({ ms: "^2.1.3" }));
		write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
		expect(commit("package.json", "pnpm-lock.yaml").status).toBe(0);
	});

	it("judges the staged lockfile, not the worktree's", () => {
		write("package.json", manifest({ ms: "^2.1.3" }));
		write("package-lock.json", lockfile({ ms: "^2.1.3" }));
		expect(commit("package.json", "package-lock.json").status).toBe(0);

		write("package.json", manifest({ once: "^1.4.0" }));
		write("package-lock.json", lockfile({ once: "^1.4.0" }));
		expectRefused(commit("package.json"), "once is not locked");
	});

	it("is armed in .husky/pre-commit on every path it reads", () => {
		const armed = new RegExp(armingPattern(CHECKER));
		expect(READS.filter((p) => !armed.test(p))).toEqual([]);
	});
});
