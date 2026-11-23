// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seenFrom } from "./lib/core-path-testkit";
import { initGitRepo, mkScratchDir } from "./lib/git-fixture";
import { GATES } from "./lib/precommit-gates.js";
import { readRuleText } from "./lib/rule-text.js";
import { shellQuote } from "./lib/sh-quote.js";

const CHECKER = "scripts/check-lockfile-sync.js";
const SCRIPT = path.join(__dirname, "check-lockfile-sync.js");
const rule = () => seenFrom(dir, () => readRuleText("lockfile-sync"));

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

const lockfile = (deps: Record<string, string>) => ({
	name: "x",
	lockfileVersion: 3,
	requires: true,
	packages: { "": { name: "x", version: "1.0.0", dependencies: deps } },
});

const git = (...args: string[]) =>
	spawnSync("git", args, { cwd: dir, encoding: "utf8" });

const commit = (...files: string[]) => {
	git("add", "--", ...files);
	const r = git("commit", "-qm", "c");
	return { status: r.status, out: r.stdout + r.stderr };
};

const expectRefused = (
	r: { status: number | null; out: string },
	says: string,
) => {
	expect(r.status).toBe(1);
	expect(r.out).toContain(says);
	expect(r.out).toContain(rule());
};

beforeEach(() => {
	dir = mkScratchDir("lockfile-sync-");
	hooks = mkScratchDir("lockfile-sync-hooks-");
	fs.writeFileSync(
		path.join(hooks, "pre-commit"),
		`#!/bin/sh\nexec node ${shellQuote(SCRIPT)}\n`,
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
		expect(r.out).not.toContain(rule());
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

	it("skips a commit staging none of the paths it reads", () => {
		write("package.json", manifest({ ms: "^2.1.3" }));
		git("add", "package.json");
		git("commit", "-qm", "out of step", "--no-verify");

		write("notes.txt", "x");
		const r = commit("notes.txt");
		expect(r.status).toBe(0);
		expect(r.out).not.toContain(rule());
	});

	it("skips a commit staging only a package.json below the root", () => {
		write("package.json", manifest({ ms: "^2.1.3" }));
		git("add", "package.json");
		git("commit", "-qm", "out of step", "--no-verify");

		fs.mkdirSync(path.join(dir, "sub"));
		write("sub/package.json", manifest({ ms: "^2.1.3" }));
		expect(commit("sub/package.json").status).toBe(0);
	});

	it.each(["package-lock.json", "npm-shrinkwrap.json"])(
		"refuses a commit that only deletes %s, naming the missing lockfile",
		(lock) => {
			write("package.json", manifest({ ms: "^2.1.3" }));
			write(lock, lockfile({ ms: "^2.1.3" }));
			expect(commit("package.json", lock).status).toBe(0);

			git("rm", "-q", lock);
			const r = git("commit", "-qm", "c");
			expectRefused(
				{ status: r.status, out: r.stdout + r.stderr },
				"declares dependencies, no lockfile",
			);
		},
	);

	it("runs on every commit, an always-armed dispatcher row (#5172)", () => {
		const row = GATES.find((g) => g.script === CHECKER);
		expect(row?.arm).toEqual({ always: true });
		expect(row?.policy).toBe("gate");
	});
});
