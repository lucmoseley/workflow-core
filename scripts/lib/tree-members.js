/*
 * tree-members.js — whether a path is in the tree a guard's closure is judged
 * in (#4508). In a checkout that tree is git's index, never the working
 * directory: an untracked or ignored file the closure probes for — a hook-local
 * lib shadowing the shared one, a sibling shadowing a run target, a require of
 * a lib no commit carries — would otherwise enter one worktree's digest and not
 * another's at the same commit. The index, not HEAD, so a file `git add`ed for
 * the commit being built is in, and a pathspec commit's temporary index
 * (GIT_INDEX_FILE) is the one read.
 *
 * A directory no checkout tops — a materialised `--root` copy, which `git
 * archive` wrote tracked-only, or a plugin cache with no `.git` — is its own
 * tree, read as it lies on disk. So is a checkout git cannot answer for, which
 * fails open as the gitignore filter does (mantahostels#2243), with its reason
 * kept for the caller to print.
 */

const fs = require("node:fs");
const path = require("node:path");

const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { GIT_TIMEOUT_MS, spawnGitSync } = require("./git.js");

/**
 * @typedef {{ index: Set<string> | null, failure: string | null }} Tree
 * `index` null where the tree is read on disk; `failure` why, where git could not answer.
 */

/** @type {Map<string, Tree>} */
const trees = new Map();

/**
 * @param {{ error?: Error, status: number | null, stderr?: unknown }} r
 * @param {string} what
 */
const failureOf = (r, what) =>
	`git ${what} failed: ${r.error?.message ?? (String(r.stderr ?? "").trim() || `exit ${r.status}`)}`;

/**
 * @param {string} base
 * @returns {Tree}
 */
function readTree(base) {
	const opts = {
		encoding: /** @type {const} */ ("utf8"),
		timeout: GIT_TIMEOUT_MS,
	};
	/* An empty prefix says `base` is a checkout's top; a materialised copy
	 * under a gitignored directory of one reads a non-empty prefix. */
	const top = spawnGitSync(["-C", base, "rev-parse", "--show-prefix"], opts);
	if (
		!top.error &&
		top.status !== 0 &&
		/not a git repository/.test(String(top.stderr))
	)
		return { index: null, failure: null };
	if (top.error || top.status !== 0)
		return { index: null, failure: failureOf(top, "rev-parse") };
	if (String(top.stdout).trim() !== "") return { index: null, failure: null };
	const listed = spawnGitSync(["-C", base, "ls-files", "-z"], {
		...opts,
		maxBuffer: CHILD_MAX_BUFFER,
	});
	if (listed.error || listed.status !== 0)
		return { index: null, failure: failureOf(listed, "ls-files") };
	const index = new Set(
		String(listed.stdout)
			.split("\0")
			.filter(Boolean)
			.map((p) => path.normalize(p)),
	);
	return { index, failure: null };
}

/**
 * `base`'s tree, read once per process.
 *
 * @param {string} base
 * @returns {Tree}
 */
function treeOf(base) {
	const key = path.resolve(base);
	let tree = trees.get(key);
	if (!tree) {
		tree = readTree(key);
		trees.set(key, tree);
	}
	return tree;
}

/**
 * Whether `rel` is in the tree `base` judges.
 *
 * @param {string} base
 * @param {string} rel a path from `base`
 */
function inTree(base, rel) {
	const { index } = treeOf(base);
	return index
		? index.has(path.normalize(rel))
		: fs.existsSync(path.join(base, rel));
}

module.exports = { inTree, treeOf };
