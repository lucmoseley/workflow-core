/** @typedef {"shared" | "linked" | "other" | "unknown"} TreeClass */

/** @param {string} dir @param {string} at */
const isAtOrUnder = (dir, at) =>
	dir === at || dir.startsWith(at.endsWith("/") ? at : `${at}/`);

/**
 * @param {Record<string, TreeClass>} layout
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
 * @property {string} root
 * @property {string | null} head
 * @property {Record<string, string | null>} [worktrees]
 * @property {string[]} [branches]
 * @property {string[]} [tags]
 */

/**
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
