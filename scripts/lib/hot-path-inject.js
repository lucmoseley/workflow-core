/*
 * hot-path-inject.js — the dispatcher core that hands a session base §G13
 * the first time it writes a hot-path program or a hook registration
 * (#5335 §Injection), as lib/test-rules-inject.js hands §X8.
 *
 * It runs on every Write, Edit and NotebookEdit: it returns on the latch before any read; it reads the
 * registrations (lib/hot-path-set.js) only for a path base §0 routes as
 * program, shell or hook module; and it starts no child process.
 *
 * LIMITS
 *  - INJECTION ONLY: it never refuses.
 *  - A file written through Bash is never seen.
 *  - A local route row is not read: a program routed only by one, with no
 *    shebang, is not seen.
 */

const path = require("node:path");
const { hotPathSet, isHookRegistration } = require("./hot-path-set.js");
const { isTestKind } = require("./test-kind.js");
const { treeOrHost } = require("./tree-or.js");

/* A literal id, which the guard registry reads as this core printing it. */
const INJECT = { injectRules: ["hot-path-cost"] };

/* Base §0's program, shell and hook module rows, bar the shebang limb. */
const ROUTED =
	/^(?:\.husky\/[^/]+|.*\.sh|\.claude\/skills\/[^/]+\/hooks\/.+|hooks\/register\.ts|(?:scripts|\.claude\/skills\/[^/]+\/scripts)\/.+\.[jt]s)$/;
/* The files whose first line is read for a shebang: a code extension a row
 * does not route, or none. */
const SHEBANG_CANDIDATE = /(?:^|\/)(?:[^./]+|[^/]+\.(?:py|c?js|mjs|ts))$/;

/**
 * Whether `rel` routes as program, shell or hook module under base §0.
 * @param {string} rel
 * @param {() => string | null} text the written file's text
 */
function routesAsCode(rel, text) {
	if (isTestKind(rel)) return false;
	if (ROUTED.test(rel)) return true;
	return SHEBANG_CANDIDATE.test(rel) && (text() ?? "").startsWith("#!");
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
	if (!routesAsCode(rel, written)) return null;
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
