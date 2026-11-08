/*
 * test-rules-inject.js — the dispatcher core that hands a session base §X8,
 * §X9 and §X10 the first time it writes a test file (workflow-core#1887, spec workflow-core#1869
 * §Delivery).
 *
 * A test file is any path base §X binds, by lib/test-kind.js's isTestKind, or
 * a test a runner collects (its COLLECTED_TEST), which a local route row may
 * send to §X, as design-vault's `*.test.py` (workflow-core#1266).
 *
 * LIMITS
 *  - INJECTION ONLY: it never refuses (workflow-core#1795).
 *  - A test file written through Bash is never seen.
 *  - Priority order is §X8, §X9, §X10: a deferral under the cap carries the
 *    later ids to the next test write, unlatched.
 */

const { COLLECTED_TEST, isTestKind } = require("./test-kind.js");
const { treeOr } = require("./tree-or.js");

/**
 * @param {string} file the path the write names
 * @param {import("./core-contract.js").CoreContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(file, ctx) {
	/* Relative to the session's tree, so a `tests/` above the checkout is never
	 * read as one in it; a write outside that tree is no test of this repo's.
	 * In a linked worktree that tree is the worktree, never the host (workflow-core#4242);
	 * where git names none for the session, the host's. */
	const rel = treeOr(ctx, ctx).repoRel(file);
	if (rel === null || !(isTestKind(rel) || COLLECTED_TEST.test(rel)))
		return null;
	return {
		injectRules: ["test-run-cost", "test-time-seam", "test-reads-visible"],
	};
}

module.exports = {
	field: ["file_path", "notebook_path"],
	noun: "write",
	decide,
};
