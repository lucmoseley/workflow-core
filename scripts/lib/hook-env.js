const path = require("node:path");
const { SELF_PLUGIN_DIR } = require("./core-hooks.js");
const { buildCheckoutEnv } = require("./refill-repos.js");

/** @param {string} root */
const selfPluginRoot = (root) => path.join(root, SELF_PLUGIN_DIR);

/**
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
const buildHookEnv = (root, env = process.env) => ({
	...buildCheckoutEnv(root, env),
	CLAUDE_PLUGIN_ROOT: selfPluginRoot(root),
});

module.exports = { buildHookEnv, selfPluginRoot };
