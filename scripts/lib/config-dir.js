const os = require("node:os");
const path = require("node:path");
const { expandHome } = require("./home-path.js");

/**
 * @param {string|null|undefined} value
 * @param {string} [home]
 * @returns {string}
 */
function configDirFrom(value, home = os.homedir()) {
	return value ?? path.join(home, ".claude");
}

/**
 * @param {string} p
 * @param {string} home
 */
function seatDir(p, home) {
	return path.resolve(expandHome(p, home) ?? p);
}

function configDir() {
	return configDirFrom(process.env.CLAUDE_CONFIG_DIR);
}

module.exports = { configDir, configDirFrom, seatDir };
