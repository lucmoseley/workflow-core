class TreeUnresolved extends Error {
	/** @param {string} cwd */
	constructor(cwd) {
		super(
			`git names no top level for ${cwd}, so the session's tree is unknown — allowed unchecked`,
		);
		this.name = "TreeUnresolved";
		this.cwd = cwd;
	}
}

/**
 * @template T, F
 * @param {{ tree: () => T }} ctx
 * @param {F} fallback
 * @returns {T | F}
 */
function treeOr(ctx, fallback) {
	try {
		return ctx.tree();
	} catch (e) {
		if (!(e instanceof Error && e.name === "TreeUnresolved")) throw e;
		return fallback;
	}
}

/**
 * @param {import("./guard-host-ports.js").TreePorts
 *   & { tree: () => import("./guard-host-ports.js").TreePorts }} ctx
 * @returns {import("./guard-host-ports.js").TreePorts}
 */
const treeOrHost = (ctx) =>
	treeOr(ctx, {
		root: ctx.root,
		git: ctx.git,
		read: ctx.read,
		readText: ctx.readText,
		repoRel: ctx.repoRel,
	});

/**
 * @param {Parameters<typeof treeOrHost>[0] & { commonDir: (dir: string) => string | null,
 *   log: (message: string) => void }} ctx
 * @returns {string}
 */
function linkedTreeOrRoot(ctx) {
	const { root } = treeOrHost(ctx);
	if (root === ctx.root) return root;
	// git before 2.31 has no --path-format: https://github.com/git/git/blob/master/Documentation/RelNotes/2.31.0.txt
	const common = ctx.commonDir(root);
	const rootCommon = ctx.commonDir(ctx.root);
	if (common === null || rootCommon === null) {
		ctx.log(
			`git rev-parse --git-common-dir failed in ${root} or ${ctx.root} — worktree paths left unmatched`,
		);
		return ctx.root;
	}
	return common === rootCommon ? root : ctx.root;
}

module.exports = {
	linkedTreeOrRoot,
	TreeUnresolved,
	treeOr,
	treeOrHost,
};
