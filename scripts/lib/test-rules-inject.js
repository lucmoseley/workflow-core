/*
 * test-rules-inject.js — the dispatcher core that hands a session base §X8,
 * §X9 and §X10 the first time it writes a test file (#1887, spec #1869
 * §Delivery).
 *
 * A test file is any path base §X binds, by lib/test-kind.js's isTestKind, or
 * a test a runner collects (its COLLECTED_TEST), which a local route row may
 * send to §X, as design-vault's `*.test.py` (#1266).
 *
 * LIMITS
 *  - INJECTION ONLY: it never refuses (#1795).
 *  - A test file written through Bash is never seen.
 *  - Priority order is §X8, §X9, §X10: a deferral under the cap carries the
 *    later ids to the next test write, unlatched.
 */

const { COLLECTED_TEST, isTestKind } = require("./test-kind.js");

/**
 * @param {string} file the path the write names
 * @param {import("./guard-dispatch.js").CoreContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(file, ctx) {
	/* Repo-relative, so a `tests/` above the checkout is never read as one in
	 * it; a write outside the checkout is no test of this repo's. */
	const rel = ctx.repoRel(file);
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
