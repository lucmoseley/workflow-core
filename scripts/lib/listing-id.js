const crypto = require("node:crypto");

/**
 * @param {string[]} names
 * @returns {string}
 */
function listingId(names) {
	return crypto
		.createHash("sha1")
		.update([...names].sort().join("\n"))
		.digest("hex");
}

module.exports = { listingId };
