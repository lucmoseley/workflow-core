const path = require("node:path");

/**
 * @param {string} name
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function machineMarkerPath(name, env) {
	const home = env.HOME || "";
	if (!path.isAbsolute(home)) throw new Error("HOME unset or not absolute");
	return path.join(home, ".claude", name);
}

module.exports = { machineMarkerPath };
