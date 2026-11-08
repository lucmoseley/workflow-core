/*
 * tree-members.js — whether a path is in the tree a guard's closure is judged
 * in (workflow-core#4508). In a checkout that tree is git's index, never the working
 * directory, so one commit gives one digest in every worktree. Membership only: the bytes hashed stay the
 * working tree's, as a pathspec commit commits them, so an unstaged edit to a
 * tracked dependency still moves the digest, and --review stands that row down
 * as dirty. The index, not HEAD, so a file `git add`ed for
 * the commit being built is in, and a pathspec commit's temporary index
 * (GIT_INDEX_FILE) is the one read.
 *
 * A directory no checkout tops — a materialised `--root` copy, which `git
 * archive` wrote tracked-only, or a plugin cache with no `.git` — is its own
 * tree, read as it lies on disk. So is a checkout git cannot answer for, with
 * its reason kept: the report fails open on it as the gitignore filter does
 * (mantahostels#2243), and --review, whose anchors would keep the disk's
 * answer, refuses.
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
const buildGitFailure = (r, what) =>
	`git ${what} failed: ${r.error?.message ?? (String(r.stderr ?? "").trim() || `exit ${r.status}`)}`;

/**
 * @param {string} base
 * @returns {Tree}
 */
function readTree(base) {
	/* Before any git call: an exported GIT_DIR would otherwise answer for a
	 * materialised copy out of the live index. */
	if (!hasOwnGit(base)) return { index: null, failure: null };
	const opts = {
		encoding: /** @type {const} */ ("utf8"),
		timeout: GIT_TIMEOUT_MS,
	};
	/* An empty prefix says git takes `base` for the top of the checkout whose
	 * `.git` it carries, and not a directory below some other work tree. */
	const top = spawnGitSync(["-C", base, "rev-parse", "--show-prefix"], opts);
	if (
		!top.error &&
		top.status !== 0 &&
		/not a git repository/.test(String(top.stderr))
	)
		return { index: null, failure: null };
	if (top.error || top.status !== 0)
		return { index: null, failure: buildGitFailure(top, "rev-parse") };
	if (String(top.stdout).trim() !== "") return { index: null, failure: null };
	const listed = spawnGitSync(["-C", base, "ls-files", "-z"], {
		...opts,
		maxBuffer: CHILD_MAX_BUFFER,
	});
	if (listed.error || listed.status !== 0)
		return { index: null, failure: buildGitFailure(listed, "ls-files") };
	const index = new Set(
		String(listed.stdout)
			.split("\0")
			.filter(Boolean)
			.map((p) => path.normalize(p)),
	);
	return { index, failure: null };
}

/**
 * Whether `dir` carries its own `.git`, not an ancestor's (workflow-core#3450).
 * @param {string} dir
 */
function hasOwnGit(dir) {
	return fs.existsSync(path.join(dir, ".git"));
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
 * @param {string} base
 * @param {string} rel a path from `base`
 */
function isTreeMember(base, rel) {
	const { index } = treeOf(base);
	return index
		? index.has(path.normalize(rel))
		: fs.existsSync(path.join(base, rel));
}

module.exports = { hasOwnGit, isTreeMember, treeOf };
