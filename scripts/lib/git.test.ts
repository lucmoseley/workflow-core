/*
 * Tests for lib/git.js, the one seam every Node `git` spawn goes through
 * (#2636). Loosen the grep and a script spawning `git` on its own escapes
 * WFC_GIT and the shared buffer cap.
 *
 * The seam is driven through a stub at WFC_GIT, not on PATH, because WFC_GIT is
 * the injection point it owns (base §N7). The grep reads the `.js` scripts and
 * the `.sh` hooks that inline node; the `.ts` files are test support.
 *
 * full-sweep-only: the two scans read every tracked script through a
 * `git ls-files` glob, so no one script's change selects them.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const lib: any = createRequire(__filename)("./git.js");
const ROOT = path.resolve(__dirname, "../..");

/**
 * The tracked files `lsFiles` lists, less `exempt`. Each caller spells its
 * `ls-files` argv out, as test-read-edges.js reads only literal pathspecs.
 */
const readTrackedScripts = (lsFiles: string[], exempt: Set<string>) =>
	execFileSync("git", lsFiles, {
		cwd: ROOT,
		encoding: "utf8",
	})
		.split("\0")
		.filter((f) => f && !exempt.has(f));

/** `file:line` for each line `find` reports in each of `files`. */
const offendersIn = (files: string[], find: (src: string) => number[]) =>
	files.flatMap((f) =>
		find(fs.readFileSync(path.join(ROOT, f), "utf8")).map(
			(line) => `${f}:${line}`,
		),
	);

/** Line numbers of `pattern`'s matches that do not sit in a comment line. */
const uncommentedLines = (src: string, pattern: RegExp) =>
	[...src.matchAll(pattern)]
		.filter((m) => {
			const lineStart = src.lastIndexOf("\n", m.index) + 1;
			return !/^\s*(\*|\/\/|\/\*)/.test(src.slice(lineStart, m.index));
		})
		.map((m) => src.slice(0, m.index).split("\n").length);

describe("the binary at WFC_GIT (#2589, #2636)", () => {
	let dir: string;
	const saved = process.env.WFC_GIT;
	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-seam-"));
		const stub = path.join(dir, "git");
		fs.writeFileSync(
			stub,
			'#!/bin/sh\n[ "$1" = fail ] && exit 3\necho "stub $*"\n',
		);
		fs.chmodSync(stub, 0o755);
		process.env.WFC_GIT = stub;
	});
	afterAll(() => {
		if (saved === undefined) delete process.env.WFC_GIT;
		else process.env.WFC_GIT = saved;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("is what every spawn shape runs", async () => {
		expect(lib.execGit(["a"], { encoding: "utf8" })).toBe("stub a\n");
		expect(lib.spawnGitSync(["b"], { encoding: "utf8" }).stdout).toBe(
			"stub b\n",
		);
		expect((await lib.execGitAsync(["c"])).stdout).toBe("stub c\n");
	});

	it("gitOrNull returns stdout, or null on a non-zero exit", () => {
		expect(lib.gitOrNull(["e"])).toBe("stub e\n");
		expect(lib.gitOrNull(["fail"])).toBeNull();
	});

	it("execGit throws on a non-zero exit", () => {
		expect(() => lib.execGit(["fail"], { stdio: "ignore" })).toThrow();
	});
});

describe("gitCommonDir and gitCommonDirOrThrow (#2737)", () => {
	let dir: string;
	beforeAll(() => {
		dir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "git-common-")),
		);
		const git = (cwd: string, ...args: string[]) =>
			execFileSync("git", args, { cwd, stdio: "ignore" });
		fs.mkdirSync(path.join(dir, "main"));
		git(path.join(dir, "main"), "init", "-q");
		git(
			path.join(dir, "main"),
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"root",
		);
		git(path.join(dir, "main"), "worktree", "add", "-q", "../wt");
		fs.mkdirSync(path.join(dir, "outside"));
	});
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("names the main checkout's .git, from it and from a linked worktree", () => {
		const common = path.join(dir, "main", ".git");
		expect(lib.gitCommonDir(path.join(dir, "main"))).toBe(common);
		expect(lib.gitCommonDir(path.join(dir, "wt"))).toBe(common);
		expect(lib.gitCommonDirOrThrow(path.join(dir, "wt"))).toBe(common);
	});

	it("is null outside a repository, where the throwing form carries git's stderr", () => {
		const outside = path.join(dir, "outside");
		const env = { ...process.env, GIT_CEILING_DIRECTORIES: dir };
		expect(lib.gitCommonDir(outside, { env })).toBeNull();
		expect(() => lib.gitCommonDirOrThrow(outside, { env })).toThrow(
			expect.objectContaining({
				stderr: expect.stringMatching(/not a git repository/i),
			}),
		);
	});
});

describe("gitSpawnOptions, for a git spawn through an injected executor (#2734)", () => {
	const { CHILD_MAX_BUFFER } = createRequire(__filename)("./child-buffer.js");

	it("adds the seam's maxBuffer and keeps the caller's options", () => {
		expect(lib.gitSpawnOptions({ cwd: "/r" })).toEqual({
			cwd: "/r",
			maxBuffer: CHILD_MAX_BUFFER,
		});
		expect(lib.gitSpawnOptions()).toEqual({ maxBuffer: CHILD_MAX_BUFFER });
		expect(lib.gitSpawnOptions({ maxBuffer: 5 }).maxBuffer).toBe(5);
	});

	it("reaches the executor a caller injects", () => {
		const seen: { maxBuffer?: number }[] = [];
		createRequire(__filename)("./dirty-tree.js").gitRead(
			["status"],
			ROOT,
			(_file: string, _args: string[], opts: { maxBuffer?: number }) => {
				seen.push(opts);
				return "";
			},
		);
		expect(seen.map((o) => o.maxBuffer)).toEqual([CHILD_MAX_BUFFER]);
	});

	/** Lines of a gitBinary() whose statement carries no gitSpawnOptions(). */
	const unwrappedLines = (src: string) =>
		[...src.matchAll(/gitBinary\(\)/g)]
			.filter((m) => {
				const end = src.indexOf(";", m.index);
				return !src.slice(m.index, end).includes("gitSpawnOptions(");
			})
			.map((m) => src.slice(0, m.index).split("\n").length);

	it("flags an executor's gitBinary() with bare options, and passes a wrapped one", () => {
		expect(unwrappedLines("execFn(gitBinary(), args, { cwd });")).toEqual([1]);
		expect(
			unwrappedLines(
				"a(gitBinary(), x, gitSpawnOptions({}));\nb(gitBinary(), y, {});",
			),
		).toEqual([2]);
		expect(
			unwrappedLines(
				"execFn(\n\tgitBinary(),\n\targs,\n\tgitSpawnOptions({ cwd }),\n);",
			),
		).toEqual([]);
	});

	it("finds none in a tracked script", () => {
		const files = readTrackedScripts(
			["ls-files", "-z", "--", "scripts/*.js", ".claude/skills/*/scripts/*.js"],
			new Set(["scripts/lib/git.js"]),
		);
		expect(offendersIn(files, unwrappedLines)).toEqual([]);
	});
});

describe('no literal "git" as a spawn\'s first argument (#2636)', () => {
	/* precommit-gate-harness.js builds fixture repos, which take the real `git`
	 * whatever a test stubs. resolve-core.js is copied into every adopter and
	 * runs before any core is found, so it requires node builtins only. */
	const exempt = new Set([
		"scripts/lib/precommit-gate-harness.js",
		"scripts/lib/resolve-core.js",
	]);

	/** A quoted `git` opening a call's arguments, or a runner's argv after its cwd. */
	const gitLiteral =
		/(?<!Set)\(\s*(?:[\w.]+\s*,\s*\[|\[)?\s*(["'`])git\1\s*[,)]/g;

	const gitLiteralLines = (src: string) => uncommentedLines(src, gitLiteral);

	it("catches each spawn shape, and passes a comment or a plain list", () => {
		expect(gitLiteralLines('execFileSync("git", ["log"]);')).toEqual([1]);
		expect(gitLiteralLines('spawnSync(\n\t"git",\n\t["log"],\n);')).toEqual([
			1,
		]);
		expect(gitLiteralLines('run(dir, ["git", "tag"]);')).toEqual([1]);
		expect(gitLiteralLines("execFileSync('git', ['log']);")).toEqual([1]);
		expect(gitLiteralLines("spawnSync(`git`, args);")).toEqual([1]);
		expect(gitLiteralLines('spawn("git");')).toEqual([1]);
		expect(gitLiteralLines(' * execFileSync("git", args)')).toEqual([]);
		expect(gitLiteralLines('const tools = ["git", "gh"];')).toEqual([]);
		expect(gitLiteralLines('add(hook, "git");')).toEqual([]);
		expect(gitLiteralLines('new Set([\n\t"git",\n]);')).toEqual([]);
	});

	it("finds none in a tracked script under scripts/, inline node in a hook included", () => {
		const files = readTrackedScripts(
			[
				"ls-files",
				"-z",
				"--",
				"scripts/*.js",
				"scripts/*.sh",
				".claude/skills/*/scripts/*.js",
			],
			exempt,
		);
		expect(offendersIn(files, gitLiteralLines)).toEqual([]);
	});
});

describe("no `--git-common-dir` read outside gitCommonDir (#2737, #3066)", () => {
	/* commit-paths.js's git() routes a spawn failure into the commit's exit
	 * codes; resolve-core.js requires builtins only (as above). */
	const exempt = new Set([
		"scripts/lib/git.js",
		"scripts/commit-paths.js",
		"scripts/lib/resolve-core.js",
	]);

	const commonDirLines = (src: string) =>
		uncommentedLines(src, /(["'`])--git-common-dir\1/g);

	it("catches a quoted flag, and passes one in a comment", () => {
		expect(
			commonDirLines('gitOrNull(["rev-parse", "--git-common-dir"]);'),
		).toEqual([1]);
		expect(commonDirLines("x(\n\t'--git-common-dir',\n);")).toEqual([2]);
		expect(commonDirLines(" * `git rev-parse --git-common-dir`")).toEqual([]);
		expect(commonDirLines('// "--git-common-dir"')).toEqual([]);
	});

	it("finds none in a tracked script", () => {
		const files = readTrackedScripts(
			["ls-files", "-z", "--", "scripts/*.js", ".claude/skills/*/scripts/*.js"],
			exempt,
		);
		expect(offendersIn(files, commonDirLines)).toEqual([]);
	});
});
