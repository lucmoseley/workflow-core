/*
 * worktree-paths.js — the one reader of `git worktree list` in the scripts.
 */

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

module.exports = { worktreePaths };
