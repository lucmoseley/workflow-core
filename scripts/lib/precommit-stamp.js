const fs = require("node:fs");
const path = require("node:path");
const { readText } = require("./file-read.js");
const { trimEndRun } = require("./trim-run.js");

/**
 * @param {string} gitDir
 */
const precommitStamp = (gitDir) => path.join(gitDir, "wfc-precommit-stamp");

/**
 * @param {string} gitDir
 * @returns {string}
 */
function takePrecommitStamp(gitDir) {
	if (!gitDir) return "";
	const stamp = precommitStamp(gitDir);
	const read = readText(stamp);
	if (read.state === "absent") return "";
	fs.rmSync(stamp, { force: true });
	return read.state === "read" ? trimEndRun(read.data, "\n") : "";
}

module.exports = { precommitStamp, takePrecommitStamp };
