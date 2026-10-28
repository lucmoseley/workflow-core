// @vitest-environment node
/*
 * lib/host-git-guard/git, the suites' `git` (#3161), refuses a write to the
 * host repository and passes every other call to the real git.
 *
 * A probe of this checkout is an empty `update-ref --stdin`, which would
 * change nothing if it ran.
 * The shim's `argv[0]` is held by commit-paths.test.ts, which reads a git
 * process's command line.
 *
 * Loosen a refusal and a test whose `cwd` misses its fixture writes to the
 * real `.git` again; widen one and a test reading the real repo goes red.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initGitRepo } from "./git-fixture";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const SHIM = path.join(repoRoot, "scripts/lib/host-git-guard/git");

let dir: string;
let host: string;
let hostCommon: string;
let other: string;
let wt: string;

const head = (repo: string) =>
	execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();

const shim = (
	args: string[],
	cwd = host,
	env: NodeJS.ProcessEnv = { WFC_HOST_GIT_DIR: hostCommon },
) =>
	spawnSync(SHIM, args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...env },
		/* 10 s, a guess: far above one git call, so a case whose shim and a
		 * git on PATH call each other (#3400) fails rather than hangs. It
		 * crosses the real clock only as that bound, asserting no time. */
		timeout: 10_000,
	});

beforeAll(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wfc-hgg-")));
	const hooks = path.join(dir, "no-hooks");
	fs.mkdirSync(hooks);
	host = path.join(dir, "host");
	other = path.join(dir, "other");
	wt = path.join(dir, "wt");
	initGitRepo(host, hooks);
	initGitRepo(other, hooks);
	execFileSync("git", ["-C", host, "worktree", "add", "-q", "--detach", wt]);
	fs.mkdirSync(path.join(host, "scratch"));
	hostCommon = path.join(host, ".git");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const expectRefused = (r: ReturnType<typeof shim>, sub: string) => {
	expect(r.status, r.stderr).toBe(128);
	expect(r.stderr).toContain(`host-git-guard: refused \`git ${sub}\``);
};

describe("a write to the host repository", () => {
	it.each([
		["a commit in its root", ["commit", "-q", "--allow-empty", "-m", "A"], ""],
		[
			"a commit from a directory that missed its fixture",
			["commit", "-q", "--allow-empty", "-m", "A"],
			"scratch",
		],
		["a reset", ["reset", "-q", "--hard", "HEAD"], ""],
		["an update-ref", ["update-ref", "refs/heads/x", "HEAD"], ""],
		["a read-tree", ["read-tree", "HEAD"], ""],
		["a new branch", ["branch", "x"], ""],
		["a new tag", ["tag", "x"], ""],
		["a config set", ["config", "user.name", "x"], ""],
		["a worktree add", ["worktree", "add", "--detach", "../wt2"], ""],
		["a stash", ["stash"], ""],
		["a symbolic-ref set", ["symbolic-ref", "HEAD", "refs/heads/x"], ""],
		["an unlisted subcommand", ["pack-refs", "--all"], ""],
		[
			"a commit behind a valued global option",
			["--attr-source", "HEAD", "commit", "-q", "--allow-empty", "-m", "A"],
			"",
		],
		[
			"a config value that looks like an option",
			["config", "core.foo", "-1"],
			"",
		],
		[
			"an init that moves the git dir",
			["init", "--separate-git-dir", "../moved"],
			"",
		],
	])("is refused: %s", (_, args, sub) => {
		const before = head(host);
		const r = shim(args, path.join(host, sub));
		expectRefused(r, args[args[0].startsWith("-") ? 2 : 0]);
		expect(head(host)).toBe(before);
		expect(fs.existsSync(path.join(dir, "moved"))).toBe(false);
		expect(fs.existsSync(path.join(dir, "wt2"))).toBe(false);
	});

	it("is refused through -C from elsewhere", () => {
		const r = shim(
			["-C", host, "commit", "-q", "--allow-empty", "-m", "A"],
			dir,
		);
		expectRefused(r, "commit");
	});

	it("is refused from a linked worktree of the host", () => {
		const before = head(wt);
		const r = shim(["commit", "-q", "--allow-empty", "-m", "A"], wt);
		expectRefused(r, "commit");
		expect(head(wt)).toBe(before);
	});
});

describe("a read of the host repository", () => {
	it.each([
		[["status", "--porcelain"]],
		[["log", "-1", "--format=%s"]],
		[["rev-parse", "HEAD"]],
		[["branch", "--show-current"]],
		[["branch", "-a"]],
		[["branch", "--list", "main"]],
		[["tag", "-l"]],
		[["config", "--get", "user.name"]],
		[["config", "user.name"]],
		[["worktree", "list"]],
		[["stash", "list"]],
		[["remote", "-v"]],
		[["symbolic-ref", "HEAD"]],
		[["reflog", "-n", "1"]],
		[["reflog", "HEAD"]],
		[["branch", "--format", "%(refname)"]],
		[["show-branch"]],
		[["archive", "--format=tar", "-o", "/dev/null", "HEAD"]],
		[["write-tree"]],
	])("runs: git %j", (args) => {
		const r = shim(args);
		expect(r.status, r.stderr).toBe(0);
		expect(r.stderr).not.toContain("host-git-guard");
	});

	it("writes an object, which moves no ref", () => {
		const r = spawnSync(SHIM, ["hash-object", "-w", "--stdin"], {
			cwd: host,
			input: "x",
			encoding: "utf8",
			env: { ...process.env, WFC_HOST_GIT_DIR: hostCommon },
		});
		expect(r.status, r.stderr).toBe(0);
	});

	it("passes git's output through", () => {
		expect(shim(["log", "-1", "--format=%s"]).stdout).toBe("init\n");
	});
});

describe("a write anywhere else", () => {
	it("runs in another repository", () => {
		const before = head(other);
		const r = shim(["commit", "-q", "--allow-empty", "-m", "B"], other);
		expect(r.status, r.stderr).toBe(0);
		expect(head(other)).not.toBe(before);
	});

	it("runs a git init inside the host", () => {
		const r = shim(["init", "-q", path.join(host, "scratch", "fresh")]);
		expect(r.status, r.stderr).toBe(0);
		expect(fs.existsSync(path.join(host, "scratch", "fresh", ".git"))).toBe(
			true,
		);
	});

	it("runs an init that moves the git dir of a new directory inside the host", () => {
		const r = shim([
			"init",
			"-q",
			"--separate-git-dir",
			path.join(dir, "sep.git"),
			path.join(host, "scratch", "sep"),
		]);
		expect(r.status, r.stderr).toBe(0);
		expect(fs.existsSync(path.join(dir, "sep.git", "HEAD"))).toBe(true);
	});

	it("runs a config write to another file from inside the host", () => {
		const file = path.join(dir, "other.cfg");
		const r = shim(["config", "-f", file, "a.b", "c"]);
		expect(r.status, r.stderr).toBe(0);
		expect(fs.readFileSync(file, "utf8")).toContain("b = c");
	});
});

describe("the host and the real git, unnamed", () => {
	it("takes the host as the repository holding the shim", () => {
		const r = spawnSync(SHIM, ["update-ref", "--stdin"], {
			cwd: repoRoot,
			input: "",
			encoding: "utf8",
			env: { ...process.env, WFC_HOST_GIT_DIR: "" },
		});
		expectRefused(r, "update-ref");
	});

	it("takes the host from the shim, not from a spawn's own GIT_DIR", () => {
		const r = spawnSync(SHIM, ["commit", "-q", "--allow-empty", "-m", "C"], {
			cwd: other,
			encoding: "utf8",
			env: {
				...process.env,
				WFC_HOST_GIT_DIR: "",
				GIT_DIR: path.join(other, ".git"),
			},
		});
		expect(r.status, r.stderr).toBe(0);
	});

	/*
	 * A LOOP HERE NEVER FORKS (#3400): each git below `exec`s, so a regression
	 * spins one pid, which shim's timeout kills.
	 */
	const onPath = (dirs: string[], rest = process.env.PATH) => ({
		WFC_HOST_GIT_DIR: hostCommon,
		PATH: [...dirs, rest].join(path.delimiter),
	});
	const expectResolvesPastGuard = (dirs: string[]) => {
		const r = shim(["rev-parse", "HEAD"], host, onPath(dirs));
		expect(
			r.error,
			"the shim and a git on PATH called each other",
		).toBeUndefined();
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout.trim()).toBe(head(host));
	};
	/** A git that execs the shim back, as a fake whose real git is `command -v git`. */
	const callsBack = () => {
		const fake = path.join(dir, "fake-git");
		fs.mkdirSync(fake, { recursive: true });
		fs.writeFileSync(
			path.join(fake, "git"),
			`#!/bin/sh\nexec "${SHIM}" "$@"\n`,
			{
				mode: 0o755,
			},
		);
		return fake;
	};

	it("skips a second spelling of its own directory on PATH", () => {
		const alias = path.join(dir, "guard-alias");
		if (!fs.existsSync(alias)) fs.symlinkSync(path.dirname(SHIM), alias);
		expectResolvesPastGuard([path.dirname(SHIM), alias]);
	});

	it("never takes a git ahead of it on PATH that execs the shim back (#3400)", () => {
		expectResolvesPastGuard([callsBack(), path.dirname(SHIM)]);
	});

	it("still refuses a host write with that git ahead of it (#3400)", () => {
		const r = shim(
			["update-ref", "refs/heads/x", "HEAD"],
			host,
			onPath([callsBack(), path.dirname(SHIM)]),
		);
		expectRefused(r, "update-ref");
	});

	it("skips another checkout's copy of the shim, either side of it (#3400)", () => {
		const copy = path.join(dir, "checkout-b", "host-git-guard");
		fs.mkdirSync(copy, { recursive: true });
		fs.copyFileSync(SHIM, path.join(copy, "git"));
		fs.chmodSync(path.join(copy, "git"), 0o755);
		expectResolvesPastGuard([path.dirname(SHIM), copy]);
		expectResolvesPastGuard([copy, path.dirname(SHIM)]);
	});

	it("stops a git that calls it back where it is off PATH, at its depth ceiling (#3400)", () => {
		const rest = (process.env.PATH ?? "")
			.split(path.delimiter)
			.filter((d) => d !== path.dirname(SHIM))
			.join(path.delimiter);
		const r = shim(["rev-parse", "HEAD"], host, onPath([callsBack()], rest));
		expect(
			r.error,
			"the shim and a git on PATH called each other",
		).toBeUndefined();
		expect(r.status).toBe(127);
		expect(r.stderr).toContain("calls this guard back (#3400)");
	});
});

describe("the suite's wiring in vitest.setup.ts", () => {
	it("puts the shim first on this worker's PATH", () => {
		expect(process.env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(SHIM));
		expect(process.env.WFC_HOST_GIT_DIR).toBe(
			execFileSync(
				"git",
				["rev-parse", "--path-format=absolute", "--git-common-dir"],
				{ cwd: repoRoot, encoding: "utf8" },
			).trim(),
		);
	});

	it("refuses a write to this checkout's repository", () => {
		const r = spawnSync("git", ["update-ref", "--stdin"], {
			cwd: repoRoot,
			input: "",
			encoding: "utf8",
		});
		expectRefused(r, "update-ref");
	});
});
