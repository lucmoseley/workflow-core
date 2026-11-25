const { COLLECTED_TEST, isTestKind } = require("./test-kind.js");
const { treeOrHost } = require("./tree-or.js");

/**
 * @param {string} file
 * @param {import("./core-contract.js").CoreContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(file, ctx) {
	const rel = treeOrHost(ctx).repoRel(file);
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
