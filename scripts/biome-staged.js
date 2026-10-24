#!/usr/bin/env node
/*
 * biome-staged.js — `biome check` over this commit's added and modified
 * paths, reading the bytes the commit carries (workflow-core#2429).
 *
 * Usage:
 *   node scripts/biome-staged.js [<biome check flag>…]
 *
 * `biome check --staged` takes its path list from the index but reads each
 * file from disk, so a commit carrying part of a file — a
 * `commit-paths.js --patch` commit (workflow-core#801), or a file edited after staging —
 * was judged on the worktree's bytes, a neighbour's uncommitted hunks
 * included. Here the index, the temporary one a pathspec commit builds
 * (GIT_INDEX_FILE) included, is extracted whole into a temp directory and
 * Biome runs there: whole, as its project rules (noImportCycles,
 * noFloatingPromises) read the files a staged one imports.
 *
 * Not a check-*.js: Biome's own report and exit code are the verdict. `biome`
 * is found on PATH, which `npm run` and the hook both point at
 * node_modules/.bin. A commit adding, modifying or retyping no
 * path runs nothing and exits 0. Exits 2, BROKEN's code, where git cannot
 * extract the index or biome will not start.
 *
 * cli-args-exempt: a pass-through wrapper; its argv is `biome check`'s.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { extractTree, git, indexTree } = require("./lib/check");
const { listTree } = require("./lib/git-objects");
const { caught } = require("./lib/caught.js");

/**
 * The paths this commit adds, modifies or retypes. --no-renames, so a
 * rename's new path reads as an add. Node's default 1 MB buffer holds some
 * 20,000 paths.
 * @returns {string[]}
 */
function stagedPaths() {
	return git(
		[
			"diff",
			"--cached",
			"--name-only",
			"--no-renames",
			"--diff-filter=AMT",
			"-z",
		],
		"listing the staged paths",
	)
		.split("\0")
		.filter(Boolean);
}

/** @returns {number} the exit code */
function main() {
	const paths = stagedPaths();
	if (paths.length === 0) return 0;

	const work = fs.mkdtempSync(path.join(os.tmpdir(), "biome-staged-"));
	try {
		const tree = path.join(work, "tree");
		fs.mkdirSync(tree);
		const sha = indexTree(path.join(work, "index"));
		extractTree(sha, tree);
		/* An intent-to-add entry is listed as added, but write-tree leaves it
		 * out of the tree, as the commit does. Judged on the tree, not the
		 * disk, so a path the extraction failed to write reaches Biome and
		 * fails there. */
		const inTree = new Set(listTree(sha, []).map((e) => e.path));
		const present = paths.filter((p) => inTree.has(p));
		if (present.length === 0) return 0;

		/* A git repo of its own, as biome.json's vcs settings expect: outside
		 * one, Biome refuses an empty or absent .gitignore. Off the hook's
		 * GIT_* variables, which name the real repo and its index. */
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
		);
		git(["init", "-q", tree], "making the extracted tree a repo", env);

		const r = spawnSync(
			"biome",
			["check", ...process.argv.slice(2), ...present],
			{ cwd: tree, env, stdio: "inherit" },
		);
		if (r.error) throw new Error(`biome would not start: ${r.error.message}`);
		return r.status ?? 1;
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

try {
	process.exitCode = main();
} catch (e) {
	process.stderr.write(`biome-staged: ${caught(e).message}\n`);
	process.exitCode = 2;
}
