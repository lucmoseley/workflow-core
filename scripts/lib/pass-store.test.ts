// @vitest-environment node
/*
 * The per-file pass store's two calls (#4790), `record` then `lookup`, on a
 * throwaway repository and its real git. Loosen a case and `npm run test`
 * skips a file whose inputs changed, or whose newest result is red: a test
 * reads green that was never run on the code it judges.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { lookup, record, storeFile } = require("./pass-store.js");
const { EDGES_FILE, repoRoot } = require("./test-pass-marker.js");

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

const A = "scripts/a.test.ts";
const B = "scripts/b.test.ts";
const VALUES = { node: "v22.0.0", arch: "arm64" };

/** A repository whose tests read `lib.js` and `doc.md`, committed. */
function repo(edges: Record<string, string[]> = { "doc.md": [A] }) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pst-")));
	dirs.push(dir);
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "T");
	fs.mkdirSync(path.join(dir, "scripts"));
	fs.mkdirSync(path.join(dir, "docs"));
	fs.writeFileSync(path.join(dir, ".gitignore"), ".claude/\n");
	for (const f of [
		A,
		B,
		"lib.js",
		"doc.md",
		"other.md",
		"vitest.config.ts",
		"vitest.setup.ts",
		"package.json",
		"package-lock.json",
	])
		write(dir, f, `${f} v0\n`);
	write(dir, EDGES_FILE, JSON.stringify({ edges }));
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "base");
	return dir;
}

function write(dir: string, file: string, text: string) {
	fs.writeFileSync(path.join(dir, file), text);
}

let clock = Date.parse("2026-11-09T10:00:00Z");
const nextAt = () => {
	clock += 60_000;
	return new Date(clock).toISOString();
};

/** A run of `files` at `dir`, each passing unless named in `failing`. */
function run(
	dir: string,
	files: string[],
	{
		failing = [] as string[],
		clean = true,
		drifted = [] as string[] | null,
		values = VALUES,
		storeRoot = dir,
		at = nextAt(),
	} = {},
) {
	return record(
		{
			sha: git(dir, "rev-parse", "HEAD"),
			at,
			tree: null,
			root: dir,
			files: files.map((file) => ({
				file,
				outcome: failing.includes(file) ? "fail" : "pass",
				imports: ["lib.js"],
			})),
			shared: ["vitest.config.ts", "vitest.setup.ts"],
			clean,
			drifted,
		},
		{ storeRoot, values, lander: false },
	);
}

const cachedOf = (
	dir: string,
	files: string[],
	{ values = VALUES, storeRoot = dir } = {},
) =>
	lookup(files, { root: dir, storeRoot, values, lander: false }).cached.map(
		(c: { file: string }) => c.file,
	);

describe("a recorded pass on identical inputs", () => {
	it("caches the file, naming the run it came from and every input it read", () => {
		const dir = repo();
		expect(run(dir, [A, B])).toBe(2);
		const found = lookup([A, B], {
			root: dir,
			storeRoot: dir,
			values: VALUES,
			lander: false,
		});
		expect(found.run).toEqual([]);
		expect(found.cached[0]).toMatchObject({
			file: A,
			source: { sha: git(dir, "rev-parse", "HEAD") },
		});
		expect(found.cached[0].reads).toEqual(
			expect.arrayContaining([
				A,
				"lib.js",
				"doc.md",
				"vitest.config.ts",
				"vitest.setup.ts",
				"package.json",
				"package-lock.json",
			]),
		);
		expect(found.notice).toBeNull();
	});

	it("caches across a commit that leaves every input unchanged", () => {
		const dir = repo();
		run(dir, [A]);
		write(dir, "other.md", "changed\n");
		git(dir, "commit", "-q", "-am", "unrelated");
		expect(cachedOf(dir, [A])).toEqual([A]);
	});

	it("reads the working tree, so an uncommitted edit to an input voids it", () => {
		const dir = repo();
		write(dir, "lib.js", "uncommitted\n");
		run(dir, [A]);
		expect(cachedOf(dir, [A])).toEqual([A]);
		git(dir, "stash", "-q");
		expect(cachedOf(dir, [A])).toEqual([]);
	});
});

describe("a change to any input voids the pass", () => {
	it.each([
		["the file itself", A],
		["an import", "lib.js"],
		["a document the manifest maps to it", "doc.md"],
		["the vitest config", "vitest.config.ts"],
		["a setup file", "vitest.setup.ts"],
		["package.json", "package.json"],
		["the lockfile", "package-lock.json"],
	])("%s", (_name, file) => {
		const dir = repo();
		run(dir, [A, B]);
		write(dir, file, "changed\n");
		const cached = cachedOf(dir, [A, B]);
		expect(cached).not.toContain(A);
		if (file === A || file === "doc.md") expect(cached).toContain(B);
	});

	it.each([
		["the Node version", { ...VALUES, node: "v24.1.0" }],
		["the architecture", { ...VALUES, arch: "x64" }],
	])("%s", (_name, values) => {
		const dir = repo();
		run(dir, [A]);
		expect(cachedOf(dir, [A], { values })).toEqual([]);
	});

	it("a document the manifest now maps to the file and the row never read", () => {
		const dir = repo();
		run(dir, [A]);
		write(
			dir,
			EDGES_FILE,
			JSON.stringify({ edges: { "doc.md": [A], "other.md": [A] } }),
		);
		expect(cachedOf(dir, [A])).toEqual([]);
	});

	it("a module reached through a require no graph records, however deep", () => {
		const dir = repo();
		write(dir, A, 'const { x } = require("../lib.js");\n');
		write(dir, "lib.js", 'module.exports = require("./deep");\n');
		write(dir, "deep.js", "module.exports = { x: 1 };\n");
		run(dir, [A]);
		expect(cachedOf(dir, [A])).toEqual([A]);
		write(dir, "deep.js", "module.exports = { x: 2 };\n");
		expect(cachedOf(dir, [A])).toEqual([]);
	});

	it("an input deleted since", () => {
		const dir = repo();
		run(dir, [A]);
		fs.rmSync(path.join(dir, "lib.js"));
		expect(cachedOf(dir, [A])).toEqual([]);
	});
});

describe("the newest result on the same content decides", () => {
	it("a newer fail voids an older pass", () => {
		const dir = repo();
		run(dir, [A]);
		run(dir, [A], { failing: [A] });
		expect(cachedOf(dir, [A])).toEqual([]);
	});

	it("a newer pass caches over an older fail", () => {
		const dir = repo();
		run(dir, [A], { failing: [A] });
		run(dir, [A]);
		expect(cachedOf(dir, [A])).toEqual([A]);
	});

	it("an older fail on other content leaves the newer pass standing", () => {
		const dir = repo();
		write(dir, "lib.js", "broken\n");
		run(dir, [A], { failing: [A] });
		write(dir, "lib.js", "lib.js v0\n");
		run(dir, [A]);
		expect(cachedOf(dir, [A])).toEqual([A]);
	});

	it("a file that passed inside a red run caches; the red one runs", () => {
		const dir = repo();
		run(dir, [A, B], { failing: [B] });
		expect(cachedOf(dir, [A, B])).toEqual([A]);
	});
});

describe("a run whose per-file verdicts cannot be trusted records nothing", () => {
	it("one that errored outside its files", () => {
		const dir = repo();
		expect(run(dir, [A], { clean: false })).toBe(0);
		expect(cachedOf(dir, [A])).toEqual([]);
	});

	it("one whose tree drift is unknown", () => {
		const dir = repo();
		expect(run(dir, [A], { drifted: null })).toBe(0);
	});

	it("records no row for a file whose input was rewritten mid-run", () => {
		const dir = repo();
		expect(run(dir, [A, B], { drifted: ["doc.md"] })).toBe(1);
		expect(cachedOf(dir, [A, B])).toEqual([B]);
	});

	it("the lander's tester, which neither writes nor reads the store", () => {
		const dir = repo();
		const files = [{ file: A, outcome: "pass", imports: [] }];
		const base = {
			sha: "x",
			at: nextAt(),
			tree: null,
			root: dir,
			files,
			shared: [],
			clean: true,
			drifted: [],
		};
		expect(record(base, { storeRoot: dir, lander: true })).toBe(0);
		run(dir, [A]);
		expect(
			lookup([A], { root: dir, storeRoot: dir, values: VALUES, lander: true })
				.cached,
		).toEqual([]);
	});
});

describe("the uncached pragma", () => {
	it("never caches a file whose header gives a reason", () => {
		const dir = repo();
		write(dir, A, "// uncached: reads the clock\nimport x from 'y';\n");
		run(dir, [A, B]);
		const found = lookup([A, B], {
			root: dir,
			storeRoot: dir,
			values: VALUES,
			lander: false,
		});
		expect(found.cached.map((c: { file: string }) => c.file)).toEqual([B]);
		expect(found.run).toEqual([A]);
	});

	it("refuses a pragma with no reason", () => {
		const dir = repo();
		write(dir, A, "/*\n * uncached:\n */\n");
		run(dir, [A, B]);
		const found = lookup([A, B], {
			root: dir,
			storeRoot: dir,
			values: VALUES,
			lander: false,
		});
		expect(found.refused).toEqual([A]);
		expect(found.cached).toEqual([]);
	});

	it("reads only the header, so the word in a test's body is no pragma", () => {
		const dir = repo();
		write(dir, A, "// a test\nconst s = 'uncached:';\n");
		run(dir, [A]);
		expect(cachedOf(dir, [A])).toEqual([A]);
	});
});

describe("a store it cannot trust runs every file", () => {
	it("an absent store, silently", () => {
		const dir = repo();
		const found = lookup([A], {
			root: dir,
			storeRoot: dir,
			values: VALUES,
			lander: false,
		});
		expect(found).toMatchObject({ cached: [], run: [A], notice: null });
	});

	it("an unreadable store, with a notice", () => {
		const dir = repo();
		fs.mkdirSync(storeFile(dir));
		const found = lookup([A], {
			root: dir,
			storeRoot: dir,
			values: VALUES,
			lander: false,
		});
		expect(found.run).toEqual([A]);
		expect(found.notice).toMatch(/could not be read/);
	});

	it("a row that will not parse, with a notice", () => {
		const dir = repo();
		run(dir, [A]);
		fs.appendFileSync(storeFile(dir), `{"files":[{"file":"${A}"\n`);
		const found = lookup([A], {
			root: dir,
			storeRoot: dir,
			values: VALUES,
			lander: false,
		});
		expect(found.cached).toEqual([]);
		expect(found.notice).toMatch(/would not parse/);
	});

	it.each([
		["missing", {}],
		["empty", { inputs: {} }],
	])("a row whose input list is %s never matches", (_name, inputs) => {
		const dir = repo();
		fs.appendFileSync(
			storeFile(dir),
			`${JSON.stringify({
				at: nextAt(),
				sha: "abc",
				values: VALUES,
				shared: {},
				files: [{ file: A, outcome: "pass", ...inputs }],
			})}\n`,
		);
		expect(cachedOf(dir, [A])).toEqual([]);
	});
});

describe("where the store lives", () => {
	it("prunes rows past the pass-marker archive's retention", () => {
		const dir = repo();
		const old = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
		run(dir, [A]);
		const line = JSON.parse(fs.readFileSync(storeFile(dir), "utf8"));
		fs.writeFileSync(
			storeFile(dir),
			`${JSON.stringify({ ...line, at: old })}\n`,
		);
		expect(cachedOf(dir, [A])).toEqual([A]);
		run(dir, [B], { at: new Date().toISOString() });
		expect(cachedOf(dir, [A, B])).toEqual([B]);
	});

	it("is the canonical checkout's, so a linked worktree's pass serves the main tree", () => {
		const dir = repo();
		const wt = path.join(dir, ".claude", "wt");
		git(dir, "worktree", "add", "-q", wt);
		run(wt, [A], { storeRoot: repoRoot(wt) });
		expect(cachedOf(dir, [A], { storeRoot: repoRoot(dir) })).toEqual([A]);
	});

	it("is each repository's own, keyed on its own files", () => {
		const one = repo();
		const two = repo();
		run(one, [A]);
		expect(cachedOf(two, [A])).toEqual([]);
		write(two, "lib.js", "an adopter's own lib\n");
		run(two, [A]);
		expect(cachedOf(two, [A])).toEqual([A]);
		expect(cachedOf(one, [A])).toEqual([A]);
	});
});
