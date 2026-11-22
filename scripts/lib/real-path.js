const fs = require("node:fs");

/** @param {string} p */
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
