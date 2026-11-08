/*
 * tree-or.js — a core's session tree where one resolves, else the fallback
 * the core names (workflow-core#4242). `ctx.tree()` throws TreeUnresolved where git names
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

module.exports = { TreeUnresolved, treeOr };
