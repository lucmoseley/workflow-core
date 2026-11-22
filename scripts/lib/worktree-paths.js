const { deref } = require("./deref.js");
const { gitRead } = require("./dirty-tree.js");

/** @param {(args: string[]) => string} readGit @returns {string[]} */
function worktreePaths(readGit) {
	return readGit(["worktree", "list", "--porcelain", "-z"])
		.split("\0")
		.filter((field) => field.startsWith("worktree "))
		.map((field) => field.slice("worktree ".length));
}

/** @param {string} root @returns {string[]|null} */
function readLinkedWorktrees(root) {
	const out = gitRead(["worktree", "list", "--porcelain", "-z"], root);
	if (out === null) return null;
	return worktreePaths(() => out)
		.slice(1)
		.map(deref);
}

module.exports = { readLinkedWorktrees, worktreePaths };
