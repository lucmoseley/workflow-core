/*
 * worktree-paths.js — the one reader of `git worktree list` in the scripts.
 */

const { deref } = require("./deref.js");
const { gitRead } = require("./dirty-tree.js");

/**
 * Each worktree's path as git lists it. `-z`: git prints a path raw, and a path
 * can hold a newline (#4053).
 * @param {(args: string[]) => string} readGit runs git, returning its stdout
 * @returns {string[]}
 */
function worktreePaths(readGit) {
	return readGit(["worktree", "list", "--porcelain", "-z"])
		.split("\0")
		.filter((field) => field.startsWith("worktree "))
		.map((field) => field.slice("worktree ".length));
}

/**
 * Every linked worktree of the repository holding `root`, symlinks
 * dereferenced, the main checkout left out — or null where git will not list
 * them. A registration whose directory is gone is listed; reading it fails
 * and the caller passes it over.
 * @param {string} root
 * @returns {string[]|null}
 */
function readLinkedWorktrees(root) {
	const out = gitRead(["worktree", "list", "--porcelain", "-z"], root);
	if (out === null) return null;
	return worktreePaths(() => out)
		.slice(1)
		.map(deref);
}

module.exports = { readLinkedWorktrees, worktreePaths };
