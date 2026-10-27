/*
 * git-tree-fake.js — the one fake of lib/git-tree.js's two ports (#2863,
 * §G7), for the guard cores' module cases: the tree class a directory has,
 * and the full ref a push source names.
 */

/** @typedef {"shared" | "linked" | "other" | "unknown"} TreeClass */

/** @param {string} dir @param {string} at */
const isAtOrUnder = (dir, at) =>
	dir === at || dir.startsWith(at.endsWith("/") ? at : `${at}/`);

/**
 * A tree classifier answering from a declared layout: a directory takes the
 * class of the deepest declared path it is at or under, so a linked worktree
 * may sit inside the shared tree; "" and anything declared nowhere answer as
 * git does for them.
 *
 * Declare a path git cannot answer for (a `.git` naming a gitdir that is gone)
 * as "unknown", and a path with nothing at it beneath a declared tree as
 * "other".
 * @param {Record<string, TreeClass>} layout absolute path → its class
 * @returns {(dir: string) => TreeClass}
 */
function fakeTreeClassifier(layout) {
	const roots = Object.keys(layout).sort((a, b) => b.length - a.length);
	return (dir) => {
		if (!dir) return "unknown";
		const at = roots.find((root) => isAtOrUnder(dir, root));
		return at === undefined ? "other" : (layout[at] ?? "other");
	};
}

/**
 * The tree classifier of a host repo that did not resolve: every read throws
 * what treeClassifier throws for it, read lazily as the guard entry reads it.
 * @param {string} root
 * @returns {(dir: string) => TreeClass}
 */
const unresolvedTreeClassifier = (root) => () => {
	throw new Error(
		`git could not resolve a git dir for ${root} — command allowed unchecked`,
	);
};

/**
 * @typedef {object} RefLayout
 * @property {string} root the repository's shared working tree
 * @property {string | null} head the branch checked out there, null where
 *   HEAD is detached
 * @property {Record<string, string | null>} [worktrees] each linked worktree's
 *   path and its own head, matched before `root` where nested inside it
 * @property {string[]} [branches] every branch no tree has checked out
 * @property {string[]} [tags]
 */

/**
 * The symbolicName port over one declared repository with no remotes, as
 * `git rev-parse --symbolic-full-name` answers in it: "" for a tree outside
 * it, a name that resolves to nothing, and a name both a branch and a tag.
 * A remote-tracking or other `refs/` name is outside what it models, and
 * throws.
 * @param {RefLayout} repo
 * @returns {(tree: string, src: string) => string}
 */
function fakeSymbolicName({
	root,
	head,
	worktrees = {},
	branches = [],
	tags = [],
}) {
	/** @type {Record<string, string | null>} */
	const treeHeads = { ...worktrees, [root]: head };
	const trees = Object.keys(treeHeads).sort((a, b) => b.length - a.length);
	const heads = new Set([
		...branches,
		...Object.values(treeHeads).filter((h) => h !== null),
	]);
	const tagSet = new Set(tags);
	/** @param {string} kind @param {string} name */
	const named = (kind, name) =>
		(kind === "heads" ? heads : tagSet).has(name) ? `refs/${kind}/${name}` : "";
	/** @param {string} src */
	const nameOf = (src) => {
		if (/^(refs\/(?!heads\/|tags\/)|remotes\/)/.test(src))
			throw new Error(`fakeSymbolicName models no ref like ${src}`);
		const qualified = /^(?:refs\/)?(heads|tags)\/(.+)$/.exec(src);
		if (qualified) return named(qualified[1] ?? "", qualified[2] ?? "");
		const isHead = heads.has(src);
		if (isHead === tagSet.has(src)) return "";
		return named(isHead ? "heads" : "tags", src);
	};
	return (tree, src) => {
		const at = trees.find((t) => isAtOrUnder(tree, t));
		if (at === undefined) return "";
		if (src !== "HEAD" && src !== "@") return nameOf(src);
		const h = treeHeads[at] ?? null;
		return h === null ? "HEAD" : `refs/heads/${h}`;
	};
}

module.exports = {
	fakeTreeClassifier,
	unresolvedTreeClassifier,
	fakeSymbolicName,
};
