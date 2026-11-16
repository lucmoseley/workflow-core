/*
 * walk-command.js — the in-session migration walk as a session in the repo
 * root types it (#5286). Its own module so the plugin-gap report and the
 * LANDING-OFF notice spell it alike; in script-path.js it would widen every
 * guard that file's readers carry.
 */

const { inCheckout } = require("./script-path.js");

/**
 * In an adopter through its copy of resolve-core.js, whose runner walks with
 * the install that lookup finds rather than the session's running bytes.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function walkCommand(env = process.env) {
	return inCheckout(env)
		? "node scripts/upgrade.js"
		: "node scripts/lib/resolve-core.js scripts/upgrade.js";
}

module.exports = { walkCommand };
