/*
 * tree-or.js — a core's session tree where one resolves, else the fallback
 * the core names (#4242). `ctx.tree()` throws TreeUnresolved where git names
 * no top level for the session's directory, which the dispatcher allows the
 * core on; a core that still has something true to say there — a remedy's
 * text, a write made by absolute path to the host's files — names what it
 * reads instead: the host's own ports, or null to judge without a tree.
 */

/** The session's directory, in which git names no top level. */
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
 * Any other throw is the core's own fault, and propagates. Matched by name, as
 * a loader can hand the dispatcher and the core separate copies of this class.
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
 * The session's tree, else the host root's own tree ports, which the
 * dispatcher hands every core beside `tree`.
 * @param {import("./guard-host-ports.js").TreePorts
 *   & { tree: () => import("./guard-host-ports.js").TreePorts }} ctx
 * @returns {import("./guard-host-ports.js").TreePorts}
 */
const treeOrHost = (ctx) =>
	treeOr(ctx, {
		root: ctx.root,
		git: ctx.git,
		readText: ctx.readText,
		repoRel: ctx.repoRel,
	});

/**
 * A file's text in `tree`, null where it is absent or will not read: the
 * fail-open read of a core that allows, logged, on either (mantahostels#103
 * §6, #4132).
 * @param {Pick<import("./guard-host-ports.js").TreePorts, "readText">} tree
 * @param {string} rel
 * @returns {string | null}
 */
function readOrNull(tree, rel) {
	try {
		return tree.readText(rel);
	} catch {
		return null;
	}
}

module.exports = { TreeUnresolved, readOrNull, treeOr, treeOrHost };
