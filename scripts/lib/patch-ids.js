const { gitRead } = require("./dirty-tree.js");

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */

/**
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
