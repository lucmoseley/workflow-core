/*
 * hook-env.js — the environment the harness gives a self-plugin hook, which
 * the guard-load probe runs every hook line under (#4716, #4736).
 */

const path = require("node:path");
const { buildCheckoutEnv } = require("./refill-repos.js");

/**
 * The environment the harness gives a self-plugin hook in checkout `root`: its
 * project dir and plugin root, which the hook lines spell their scripts off
 * (#4701, #4716).
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
const buildHookEnv = (root, env = process.env) => ({
	...buildCheckoutEnv(root, env),
	CLAUDE_PLUGIN_ROOT: path.join(root, "self-plugin"),
});

module.exports = { buildHookEnv };
