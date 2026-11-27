const fs = require("node:fs");
const path = require("node:path");
const { ignoreFailure } = require("./caught.js");
const { hostRoot } = require("./host-root.js");

/**
 * @param {string} dir
 * @returns {string}
 */
function ensure(dir) {
	ignoreFailure(() => fs.mkdirSync(dir, { recursive: true }));
	return dir;
}

/**
 * @param {string} [root]
 * @returns {string}
 */
const MARKERS_REL = path.join(".claude", "tmp", "markers");

const PASS_MARKER_PREFIXES = [".concision-pass-", ".codereview-pass-"];

const SELF_PLUGIN_PREFIX = ".self-plugin-loaded-";

function markersDir(root = hostRoot()) {
	return ensure(path.join(root, MARKERS_REL));
}

module.exports = {
	MARKERS_REL,
	markersDir,
	PASS_MARKER_PREFIXES,
	SELF_PLUGIN_PREFIX,
};
