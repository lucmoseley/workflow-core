const path = require("node:path");
const {
	CODE_FILE,
	PROGRAM_SPELLING,
	hotPathSet,
	isHookRegistration,
} = require("./hot-path-set.js");
const { isTestKind } = require("./test-kind.js");
const { throwUnreadable } = require("./file-read.js");
const { treeOrHost } = require("./tree-or.js");

const INJECT = { injectRules: ["hot-path-cost"] };

/**
 * @param {string} rel
 * @param {() => string | null} text
 */
function isSpeltAsProgram(rel, text) {
	if (isTestKind(rel) || !PROGRAM_SPELLING.test(rel)) return false;
	return CODE_FILE.test(rel) || (text() ?? "").startsWith("#!");
}

/**
 * @param {string} file
 * @param {import("./core-contract.js").CoreContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(file, ctx) {
	if (ctx.told("hot-path-cost")) return null;
	const tree = treeOrHost(ctx);
	const rel = tree.repoRel(file);
	if (rel === null) return null;
	if (isHookRegistration(rel)) return INJECT;
	const written = () =>
		typeof ctx.input.content === "string"
			? ctx.input.content
			: throwUnreadable(tree.read(rel));
	if (!isSpeltAsProgram(rel, written)) return null;
	const set = hotPathSet(tree.root, {
		read: tree.read,
		isFile: (p) => ctx.isFile(path.join(tree.root, p)),
	});
	return set.includes(rel) ? INJECT : null;
}

module.exports = {
	field: ["file_path", "notebook_path"],
	noun: "write",
	decide,
};
