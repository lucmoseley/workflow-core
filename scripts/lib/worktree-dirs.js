/*
 * worktree-dirs.js — where the worktrees folder and what lives in it sit,
 * relative to the main checkout. A leaf (#4703), so a hook needing one
 * location pays for no more: npm-install-host.js once loaded the whole
 * checkout for STORES.
 */

const path = require("node:path");

const WORKTREES = path.join(".claude", "worktrees");
/* A session name may not start with a dot, so none collides with it. */
const STORES = path.join(WORKTREES, ".dep-stores");
/* The queue lander's local tester checks out the sha it tests here. The
 * session reaper leaves this tree alone (#4421). */
const LANDER_WORKTREE = path.join(WORKTREES, "lander");

/**
 * `dir` sits where a cut puts a session's worktree, directly under `root`'s
 * worktrees folder, and is not the queue lander's own tree (#4421): that tree
 * is never reaped, the lander rebuilding it itself, and no session launches
 * into it.
 * @param {string} root the main checkout
 * @param {string} dir
 */
function isSessionWorktreeDir(root, dir) {
	const at = path.resolve(dir);
	return (
		path.dirname(at) === path.join(root, WORKTREES) &&
		at !== path.join(root, LANDER_WORKTREE)
	);
}

module.exports = { isSessionWorktreeDir, LANDER_WORKTREE, STORES, WORKTREES };
