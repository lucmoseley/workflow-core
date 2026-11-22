const { readText } = require("./file-read.js");

/** @param {string} p */
function readBodyFile(p) {
	const got = readText(p);
	if (got.state === "unreadable") throw got.error;
	return got.state === "read" ? got.data : undefined;
}

module.exports = { readBodyFile };
