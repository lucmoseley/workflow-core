/*
 * real-path.js — a path with its symlinks resolved, or null where it is not
 * there to resolve.
 */

const fs = require("node:fs");

/**
 * `p` resolved; null where it, or a directory on its way, does not exist.
 * Any other failure throws.
 * @param {string} p
 */
function realPathOrNull(p) {
	try {
		return fs.realpathSync(p);
	} catch (err) {
		const { code } = /** @type {NodeJS.ErrnoException} */ (err);
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		throw err;
	}
}

module.exports = { realPathOrNull };
