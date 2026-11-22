const { orFallback } = require("./caught.js");
const { gitCommonDir } = require("./git.js");
const { gitTopLevel } = require("./host-root.js");
const { deref } = require("./deref.js");
const { coreRoot } = require("./script-path.js");

/**
 * @param {string} [cwd]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function inCoreRepo(cwd = process.cwd(), env = process.env) {
	const core = coreRoot(env);
	if (orFallback(() => gitTopLevel(core), null) !== deref(core)) return false;
	const own = gitCommonDir(core);
	return own !== null && own === gitCommonDir(cwd);
}

module.exports = { inCoreRepo };
