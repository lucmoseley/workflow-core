const fs = require("node:fs");
const path = require("node:path");
const { spawnGitSync } = require("./git.js");

const MAIN_REF = "refs/heads/main";

/**
 * @param {string} commonDir
 * @param {number} timeout
 * @returns {"unreadable"|"readable"|"no-ref-file"|"unknown"}
 */
function readMainState(commonDir, timeout) {
	if (!fs.existsSync(path.join(commonDir, MAIN_REF))) return "no-ref-file";
	const r = spawnGitSync(
		["--git-dir", commonDir, "rev-parse", "--verify", MAIN_REF],
		{ stdio: "ignore", timeout },
	);
	if (r.error || r.status === null) return "unknown";
	return r.status === 0 ? "readable" : "unreadable";
}

module.exports = { MAIN_REF, readMainState };
