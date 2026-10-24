// @vitest-environment node
/*
 * The pre-push mod-test gate (#857) driven as git drives it: ref lines on
 * stdin, over real repositories, with `claude` a stub at WFC_CLAUDE_BIN that
 * records each run and answers as 2.1.289's runner does. The hook's own
 * wiring is spawned, not run in-process, because it is a shell file.
 *
 * It is a hard gate in `.husky/pre-push`, which refuses on its exit 2: loosen
 * a case here and a push carrying a broken delivery mod reaches adopters, or a
 * missing or too-old `claude` refuses every push that touches the mod.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "run-mod-tests.js");
const HOOK = path.join(__dirname, "..", ".husky", "pre-push");
const MOD = ".claude/skills/wfc-delivery";
const ZERO = "0".repeat(40);

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

const tmp = (prefix: string) => {
	const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	dirs.push(d);
	return d;
};

const git = (dir: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd: dir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();

/** A repository whose published `origin/main` already holds the mod. */
function repo() {
	const dir = tmp("modtests-");
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "t");
	const root = commitTouching(dir, `${MOD}/tests/a.test.ts`, "other.txt");
	git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
	return { dir, root };
}

function commitTouching(dir: string, ...paths: string[]) {
	for (const rel of paths) {
		fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), `${rel} ${Math.random()}\n`);
	}
	git(dir, "add", "--", ...paths);
	git(dir, "commit", "-q", "-m", "c");
	return git(dir, "rev-parse", "HEAD");
}

function stubClaude(version = "2.1.294 (Claude Code)") {
	const bin = path.join(tmp("modtests-bin-"), "claude");
	const log = `${bin}.log`;
	fs.writeFileSync(
		bin,
		[
			"#!/bin/sh",
			`if [ "$1" = --version ]; then echo "${version}"; exit 0; fi`,
			`echo "$3" >> "${log}"`,
			`if [ -f "$3/UNUSABLE" ]; then echo "error: unknown command 'test'" >&2; exit 1; fi`,
			`if [ -f "$3/FAIL" ]; then printf '(fail) a broken test\\n\\n 0 pass\\n 1 fail\\n'; exit 1; fi`,
			`printf ' 8 pass\\n 0 fail\\n'`,
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	return {
		bin,
		runs: () =>
			fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [],
	};
}

function push(
	dir: string,
	sha: string,
	remote: string,
	{
		bin,
		stdin = `refs/heads/main ${sha} refs/heads/main ${remote}\n`,
	}: { bin: string; stdin?: string },
) {
	return runInProcess(SCRIPT, [], {
		cwd: dir,
		stdin,
		env: { ...process.env, WFC_CLAUDE_BIN: bin },
	});
}

describe("run-mod-tests (#857)", () => {
	it("runs the mod's tests where the range touches its folder, and passes on green", () => {
		const { dir, root } = repo();
		const sha = commitTouching(dir, `${MOD}/hooks/register.ts`);
		const claude = stubClaude();
		const r = push(dir, sha, root, { bin: claude.bin });
		expect(r.status).toBe(0);
		expect(claude.runs()).toHaveLength(1);
		expect(r.stderr).toContain(
			`wfc-delivery's plugin tests pass at ${sha.slice(0, 7)}`,
		);
	});

	it("refuses with exit 2, the runner's output and the way out on a failing test", () => {
		const { dir, root } = repo();
		const sha = commitTouching(dir, `${MOD}/FAIL`);
		const r = push(dir, sha, root, { bin: stubClaude().bin });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("(fail) a broken test");
		expect(r.stderr).toContain("wfc-delivery's plugin tests fail");
		expect(r.stderr).toContain("Fix the mod, commit, and push again");
	});

	it("runs the liveness mod's tests, and only its, where the range touches that folder alone (#865)", () => {
		const { dir, root } = repo();
		const sha = commitTouching(
			dir,
			".claude/skills/wfc-liveness/hooks/register.tsx",
		);
		const claude = stubClaude();
		const r = push(dir, sha, root, { bin: claude.bin });
		expect(r.status).toBe(0);
		expect(claude.runs()).toEqual([
			expect.stringMatching(/\/\.claude\/skills\/wfc-liveness$/),
		]);
		expect(r.stderr).toContain("wfc-liveness's plugin tests pass");
	});

	it("runs nothing where the range leaves the folder alone", () => {
		const { dir, root } = repo();
		const sha = commitTouching(dir, "other.txt");
		const claude = stubClaude();
		const r = push(dir, sha, root, { bin: claude.bin });
		expect(r.status).toBe(0);
		expect(claude.runs()).toEqual([]);
		expect(r.stderr).toBe("");
	});

	it("measures a new branch's range from origin/main", () => {
		const { dir } = repo();
		const sha = commitTouching(dir, "other.txt");
		const claude = stubClaude();
		const r = push(dir, sha, ZERO, { bin: claude.bin });
		expect(r.status).toBe(0);
		expect(claude.runs()).toEqual([]);
		expect(r.stderr).toBe("");
	});

	it("measures a new branch's range from origin/landing where the landing module is on (#2408)", () => {
		const { dir, root } = repo();
		git(dir, "update-ref", "refs/remotes/origin/landing", root);
		const sha = commitTouching(dir, `${MOD}/hooks/register.ts`);
		git(dir, "update-ref", "refs/remotes/origin/main", sha);
		const claude = stubClaude();
		vi.stubEnv("WFC_MODULES", "landing");
		try {
			const r = push(dir, sha, ZERO, { bin: claude.bin });
			expect(r.status).toBe(0);
		} finally {
			vi.unstubAllEnvs();
		}
		expect(claude.runs()).toHaveLength(1);
	});

	it("tests the pushed commit's bytes, not the working tree's", () => {
		const { dir, root } = repo();
		const sha = commitTouching(dir, `${MOD}/hooks/register.ts`);
		fs.writeFileSync(path.join(dir, MOD, "FAIL"), "a neighbour's file\n");
		const claude = stubClaude();
		const r = push(dir, sha, root, { bin: claude.bin });
		expect(r.status).toBe(0);
		expect(claude.runs()).toHaveLength(1);
		expect(r.stderr).toContain("plugin tests pass");
	});

	it("warns and passes where no `claude` binary is found", () => {
		const { dir, root } = repo();
		const sha = commitTouching(dir, `${MOD}/FAIL`);
		const r = push(dir, sha, root, {
			bin: path.join(tmp("modtests-none-"), "claude"),
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("WARN");
		expect(r.stderr).toContain("binary found");
		expect(r.stderr).toContain("The push proceeds untested");
	});

	it("warns and passes where `claude` exits without a test result, naming its exit code and passing on its stderr", () => {
		const { dir, root } = repo();
		const sha = commitTouching(dir, `${MOD}/UNUSABLE`);
		const r = push(dir, sha, root, { bin: stubClaude().bin });
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("exited 1 without a test result");
		expect(r.stderr).toContain("unknown command");
	});

	describe("the README's test floor (#901)", () => {
		/** A failing mod whose README, committed with it, states 2.1.293. */
		function failingWithFloor() {
			const { dir, root } = repo();
			fs.writeFileSync(
				path.join(dir, MOD, "README.md"),
				"**The tests need Claude Code 2.1.293 or later** (#896).\n",
			);
			git(dir, "add", "--", `${MOD}/README.md`);
			return { dir, root, sha: commitTouching(dir, `${MOD}/FAIL`) };
		}

		it("warns and passes, naming both versions, where `claude` is below it", () => {
			const { dir, root, sha } = failingWithFloor();
			const claude = stubClaude("2.1.292 (Claude Code)");
			const r = push(dir, sha, root, { bin: claude.bin });
			expect(r.status).toBe(0);
			expect(claude.runs()).toEqual([]);
			expect(r.stderr).toContain("WARN");
			expect(r.stderr).toContain("is 2.1.292, below 2.1.293");
			expect(r.stderr).toContain("(#901)");
			expect(r.stderr).toContain("The push proceeds untested");
		});

		it("still refuses a failing test at or above it, naming the claude version", () => {
			const { dir, root, sha } = failingWithFloor();
			const r = push(dir, sha, root, { bin: stubClaude("2.1.293").bin });
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("fail at");
			expect(r.stderr).toContain("on `claude` 2.1.293, so the push is refused");
		});

		it("reads the version off a line after a banner", () => {
			const { dir, root, sha } = failingWithFloor();
			const r = push(dir, sha, root, {
				bin: stubClaude("An update is ready\n2.1.292").bin,
			});
			expect(r.status).toBe(0);
			expect(r.stderr).toContain("is 2.1.292, below 2.1.293");
		});

		it("runs the tests where `claude --version` gives no number", () => {
			const { dir, root, sha } = failingWithFloor();
			const r = push(dir, sha, root, { bin: stubClaude("").bin });
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(
				"on `claude` of unread version, so the push is refused",
			);
		});

		it("is the sentence the delivery mod's README states it in", () => {
			const readme = fs.readFileSync(
				path.join(__dirname, "..", ".claude/skills/wfc-delivery/README.md"),
				"utf8",
			);
			expect(readme).toMatch(
				/\*\*The tests need Claude Code \d+\.\d+\.\d+ or later\*\*/,
			);
		});
	});

	it("skips a tag, whose release tree carries no mod sources (#932)", () => {
		const { dir, root } = repo();
		const sha = commitTouching(dir, `${MOD}/hooks/register.ts`);
		const claude = stubClaude();
		const tag = `refs/tags/v9.9.9 ${sha} refs/tags/v9.9.9 ${ZERO}\n`;
		const r = push(dir, sha, ZERO, { bin: claude.bin, stdin: tag });
		expect(r.status).toBe(0);
		expect(claude.runs()).toEqual([]);
		expect(r.stderr).toBe("");
		expect(push(dir, sha, root, { bin: claude.bin }).status).toBe(0);
		expect(claude.runs()).toHaveLength(1);
	});

	it("still tests a branch pushed beside a tag at the same commit (#932)", () => {
		const { dir, root } = repo();
		const sha = commitTouching(dir, `${MOD}/hooks/register.ts`);
		const claude = stubClaude();
		const r = push(dir, sha, root, {
			bin: claude.bin,
			stdin: `refs/tags/v9.9.9 ${sha} refs/tags/v9.9.9 ${ZERO}\nrefs/heads/main ${sha} refs/heads/main ${root}\n`,
		});
		expect(r.status).toBe(0);
		expect(claude.runs()).toHaveLength(1);
	});

	it("skips a deletion", () => {
		const { dir } = repo();
		const claude = stubClaude();
		const r = push(dir, ZERO, ZERO, { bin: claude.bin });
		expect(r.status).toBe(0);
		expect(claude.runs()).toEqual([]);
		expect(r.stderr).toBe("");
	});
});

describe("run-mod-tests --all, the sweep's run (#1854)", () => {
	/** A repository holding both mods, the delivery one carrying `extra`. */
	function bothMods(...extra: string[]) {
		const { dir } = repo();
		commitTouching(
			dir,
			".claude/skills/wfc-liveness/hooks/register.tsx",
			...extra,
		);
		return dir;
	}

	const sweep = (dir: string, bin: string) =>
		runInProcess(SCRIPT, ["--all"], {
			cwd: dir,
			stdin: "",
			env: { ...process.env, WFC_CLAUDE_BIN: bin },
		});

	it("tests every mod at HEAD, with no ref list, and exits 0 on green", () => {
		const claude = stubClaude();
		const r = sweep(bothMods(), claude.bin);
		expect(r.status).toBe(0);
		expect(claude.runs()).toEqual([
			expect.stringMatching(/\/\.claude\/skills\/wfc-delivery$/),
			expect.stringMatching(/\/\.claude\/skills\/wfc-liveness$/),
		]);
		expect(r.stderr).toContain("wfc-liveness's plugin tests pass");
	});

	it("exits 1 on a failing test, naming the claude version, and still tests the other mod", () => {
		const claude = stubClaude("2.1.302 (Claude Code)");
		const r = sweep(bothMods(`${MOD}/FAIL`), claude.bin);
		expect(r.status).toBe(1);
		expect(claude.runs()).toHaveLength(2);
		expect(r.stderr).toContain("(fail) a broken test");
		expect(r.stderr).toContain(
			"wfc-delivery's plugin tests fail on `claude` 2.1.302",
		);
		expect(r.stderr).toContain(`\`claude plugin test ${MOD}\` reruns them`);
	});

	it("exits 1, never passing untested, where no `claude` binary is found", () => {
		const r = sweep(bothMods(), path.join(tmp("modtests-none-"), "claude"));
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			"were not run on `claude` of unread version: no `",
		);
	});

	it("exits 1 where a mod in MODS is missing from the tree", () => {
		const { dir } = repo();
		const claude = stubClaude();
		const r = sweep(dir, claude.bin);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			".claude/skills/wfc-liveness is not in the tree",
		);
		expect(r.stderr).toContain("update MODS");
		expect(claude.runs()).toHaveLength(1);
	});
});

describe(".husky/pre-push's wiring (#857)", () => {
	/* The hook resolves both checkers under the repository's own root, so a
	 * stub there exiting `code` stands in for the mod gate. */
	function hookWith(code: number) {
		const { dir } = repo();
		fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(dir, "scripts/check-test-marker.js"), "");
		fs.writeFileSync(
			path.join(dir, "scripts/run-mod-tests.js"),
			`require("node:fs").readFileSync(0); process.exit(${code});\n`,
		);
		return spawnSync("sh", [HOOK], {
			cwd: dir,
			input: `refs/heads/main ${"1".repeat(40)} refs/heads/main ${ZERO}\n`,
			encoding: "utf8",
		});
	}

	it("refuses the push on the gate's exit 2", () => {
		expect(hookWith(2).status).toBe(1);
	});

	it("lets the push through on any other exit, a crash's 1 included", () => {
		expect(hookWith(0).status).toBe(0);
		expect(hookWith(1).status).toBe(0);
	});
});
