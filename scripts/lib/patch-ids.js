/*
 * patch-ids.js — commits' `git patch-id --stable`, the identity a rebase
 * keeps. A landed commit is a rebased twin of the worktree commit a review
 * read, with a new sha, so spec-commits.js --since matches the two by
 * patch-id to skip what was already reviewed (#3240).
 */

const { gitRead } = require("./dirty-tree.js");

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */

/**
 * Each of `commits`' `git patch-id --stable`, by sha, a commit with no patch
 * or that git no longer has left out — or null where git will not answer.
 *
 * @param {string[]} commits
 * @param {string} root
 * @param {ExecFn} [execFn]
 * @returns {Map<string, string>|null}
 */
function readPatchIds(commits, root, execFn) {
	/** @type {Map<string, string>} */
	const ids = new Map();
	if (commits.length === 0) return ids;
	const patches = gitRead(
		// No context lines: a neighbour's edit beside the commit's own, which
		// a rebase carries under it, would otherwise change its patch-id.
		["diff-tree", "--stdin", "--root", "-p", "-U0", "--no-renames"],
		root,
		execFn,
		`${commits.join("\n")}\n`,
	);
	if (patches === null) return null;
	const out = gitRead(["patch-id", "--stable"], root, execFn, patches);
	if (out === null) return null;
	for (const line of out.split("\n")) {
		const [id, sha] = line.trim().split(" ");
		if (id && sha) ids.set(sha, id);
	}
	return ids;
}

module.exports = { readPatchIds };
