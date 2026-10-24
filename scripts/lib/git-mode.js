/*
 * git-mode.js — the one spelling of each git file mode a reader tests an
 * ls-tree, ls-files or diff-tree record against (#2382).
 */

const GIT_MODE = Object.freeze({
	tree: "040000",
	symlink: "120000",
	/* A commit in another repository: this one holds no object for it. */
	gitlink: "160000",
});

module.exports = { GIT_MODE };
