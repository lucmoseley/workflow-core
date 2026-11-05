/*
 * build-state.js — where a build unit's state file lives, and which issue a
 * session is building (#4410).
 *
 * ONE FILE PER ISSUE, in the main checkout's `.claude/tmp/build-state/`, so a
 * successor session in another worktree finds it by the issue number alone,
 * without its predecessor's session id. The session writes the file itself;
 * `scripts/build-state.js` creates or resumes it and prints its path.
 *
 * THE MAIN CHECKOUT, NOT THE HOST ROOT: a hook is handed `CLAUDE_PROJECT_DIR`,
 * the main checkout, while a session's Bash call in a linked worktree resolves
 * the host root to that worktree, so the two would name two files.
 */

const path = require("node:path");
const { hostRoot } = require("./host-root.js");
const { mainCheckout } = require("./main-checkout.js");

const BUILD_STATE_REL = path.join(".claude", "tmp", "build-state");

function buildStateRoot() {
	if (process.env.WFC_REPO_ROOT) return process.env.WFC_REPO_ROOT;
	const host = hostRoot();
	return mainCheckout(host) ?? host;
}

/**
 * @param {number} issue
 * @param {string} [root]
 */
function buildStateFile(issue, root = buildStateRoot()) {
	return path.join(root, BUILD_STATE_REL, `${issue}.json`);
}

/**
 * A new unit's state, in the shape #4410 fixes.
 * @param {number} issue
 * @param {number|null} spec
 */
function newBuildState(issue, spec) {
	return {
		issue,
		spec,
		slices: [],
		standingRules: [],
		filesTouched: [],
		next: "",
		updatedAt: new Date().toISOString(),
	};
}

/**
 * The issue `sid`'s arbiter claim holds — its newest where it holds several —
 * or null where it holds none or the store will not read.
 * @param {string} sid
 * @returns {number|null}
 */
function claimedIssue(sid) {
	const listed = require("./arbiter-issue-claims.js").listIssueClaims();
	const mine = (listed?.claims ?? []).filter(
		(c) => c?.sessionId === sid && typeof c.issue === "number",
	);
	mine.sort((a, b) => String(b.claimedAt).localeCompare(String(a.claimedAt)));
	return mine[0]?.issue ?? null;
}

module.exports = {
	BUILD_STATE_REL,
	buildStateFile,
	buildStateRoot,
	claimedIssue,
	newBuildState,
};
