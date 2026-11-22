const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");

/** @param {string} dir */
function canHoldState(dir) {
	for (let at = dir; ; at = path.dirname(at)) {
		const mode =
			at === dir
				? fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK
				: fs.constants.W_OK | fs.constants.X_OK;
		try {
			fs.accessSync(at, mode);
			return true;
		} catch (err) {
			if (caught(err).code !== "ENOENT") return false;
			if (isPresent(at)) return false;
			if (path.dirname(at) === at) return false;
		}
	}
}

/** @param {string} at */
function isPresent(at) {
	try {
		fs.lstatSync(at);
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {string} pinned
 * @param {string[]} candidates
 */
const pinnedOrFirstUsable = (pinned, candidates) =>
	canHoldState(pinned)
		? pinned
		: [...candidates].sort().find(canHoldState) || pinned;

module.exports = { canHoldState, pinnedOrFirstUsable };
