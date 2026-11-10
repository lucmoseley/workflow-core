/*
 * listing-id.js — the identity of a directory listing (#4916): its names,
 * sorted and hashed. The read audit records it for each listing a test made;
 * the pass store compares it against the listing now, in the working tree or
 * a commit's tree.
 */

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
