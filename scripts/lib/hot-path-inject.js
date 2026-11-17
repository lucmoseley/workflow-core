/*
 * hot-path-inject.js — the dispatcher core that hands a session base §G13
 * the first time it writes a hot-path program or a hook registration
 * (#5335 §Injection), as lib/test-rules-inject.js hands §X8.
 *
 * It runs on every Write, Edit and NotebookEdit: it returns on the latch before any read; it reads the
 * registrations (lib/hot-path-set.js) only for a path spelt as a program —
 * a code extension, or none and a shebang — the spelling a registration's
 * program must have to enter the set; and it starts no child process.
 *
 * LIMITS
 *  - INJECTION ONLY: it never refuses.
 *  - A file written through Bash is never seen.
 *  - A `polled` program spelt otherwise (another extension, or none and no
 *    shebang) is in the set but never told.
 */

const path = require("node:path");
const {
	CODE_FILE,
	PROGRAM_SPELLING,
	hotPathSet,
	isHookRegistration,
} = require("./hot-path-set.js");
const { isTestKind } = require("./test-kind.js");
const { treeOrHost } = require("./tree-or.js");

/* A literal id, which the guard registry reads as this core printing it. */
const INJECT = { injectRules: ["hot-path-cost"] };

/**
 * Whether `rel` is spelt as a program the hot-path set could hold.
 * @param {string} rel
 * @param {() => string | null} text the written file's text
 */
function isSpeltAsProgram(rel, text) {
	if (isTestKind(rel) || !PROGRAM_SPELLING.test(rel)) return false;
	return CODE_FILE.test(rel) || (text() ?? "").startsWith("#!");
}

/**
 * @param {string} file the path the write names
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
			: tree.readText(rel);
	if (!isSpeltAsProgram(rel, written)) return null;
	const set = hotPathSet(tree.root, {
		readText: tree.readText,
		isFile: (p) => ctx.isFile(path.join(tree.root, p)),
	});
	return set.includes(rel) ? INJECT : null;
}

module.exports = {
	field: ["file_path", "notebook_path"],
	noun: "write",
	decide,
};
