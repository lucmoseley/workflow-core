/*
 * tree-or.js — a core's session tree where one resolves, else the fallback
 * the core names (#4242). `ctx.tree()` throws where git names no top level
 * for the session's directory, which the dispatcher allows the core on; a
 * core that still has something true to say there — a remedy's text, a
 * write made by absolute path to the host's files — names what it reads
 * instead: the host's own ports, or null to judge without a tree.
 */

/**
 * @template F
 * @param {{ tree: () => import("./guard-dispatch.js").TreePorts }} ctx
 * @param {F} fallback
 * @returns {import("./guard-dispatch.js").TreePorts | F}
 */
function treeOr(ctx, fallback) {
	try {
		return ctx.tree();
	} catch {
		return fallback;
	}
}

module.exports = { treeOr };
