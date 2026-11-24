const path = require("node:path");
const { repoRoot } = require("./hook-block.js");

const BUILD_STATE_REL = path.join(".claude", "tmp", "build-state");

/** @param {number} issue */
function buildStateFile(issue) {
	return path.join(repoRoot(), BUILD_STATE_REL, `${issue}.json`);
}

/**
 * @param {number} issue
 * @param {number|null} spec
 * @param {number} at
 */
function newBuildState(issue, spec, at) {
	return {
		issue,
		spec,
		slices: [],
		standingRules: [],
		filesTouched: [],
		next: "",
		updatedAt: new Date(at).toISOString(),
	};
}

module.exports = {
	buildStateFile,
	newBuildState,
};
