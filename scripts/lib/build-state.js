/*
 * build-state.js — where a build unit's state file lives (workflow-core#4410).
 *
 * ONE FILE PER ISSUE, in the main checkout's `.claude/tmp/build-state/`, so a
 * successor session in another worktree finds it by the issue number alone,
 * without its predecessor's session id.
 * Rooted on `hook-block.js`'s `repoRoot()`, so the hook and a session's own
 * Bash call in a linked worktree name one file.
 */

const path = require("node:path");
const { repoRoot } = require("./hook-block.js");

const BUILD_STATE_REL = path.join(".claude", "tmp", "build-state");

/** @param {number} issue */
function buildStateFile(issue) {
	return path.join(repoRoot(), BUILD_STATE_REL, `${issue}.json`);
}

/**
 * A new unit's state, in the shape workflow-core#4410 fixes.
 * @param {number} issue
 * @param {number|null} spec
 * @param {number} at epoch ms, the caller's `now()` (lib/check.js)
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
