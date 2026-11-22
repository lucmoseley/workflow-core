const path = require("node:path");

const WORKTREES = path.join(".claude", "worktrees");
const STORES = path.join(WORKTREES, ".dep-stores");
const LANDER_WORKTREE = path.join(WORKTREES, "lander");

/** @param {string} root @param {string} dir */
function isSessionWorktreeDir(root, dir) {
	const at = path.resolve(dir);
	return (
		path.dirname(at) === path.join(root, WORKTREES) &&
		at !== path.join(root, LANDER_WORKTREE)
	);
}

module.exports = { isSessionWorktreeDir, LANDER_WORKTREE, STORES, WORKTREES };
