const { isCoreRepo } = require("./script-path.js");

/** @param {NodeJS.ProcessEnv} [env] @returns {string} */
function walkCommand(env = process.env) {
	return isCoreRepo(env)
		? "node scripts/upgrade.js"
		: "node scripts/lib/resolve-core.js scripts/upgrade.js";
}

module.exports = { walkCommand };
