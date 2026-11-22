const fs = require("node:fs");
const path = require("node:path");

/**
 * @param {string} p
 * @returns {string}
 */
function deref(p) {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
}

/** @param {string} dir */
const realKey = (dir) => deref(path.resolve(dir));

module.exports = { deref, realKey };
