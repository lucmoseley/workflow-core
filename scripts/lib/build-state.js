/*
 * build-state.js — where a build unit's state file lives, and which issue a
 * session is building (#4410).
 *
 * ONE FILE PER ISSUE, in the main checkout's `.claude/tmp/build-state/`, so a
 * successor session in another worktree finds it by the issue number alone,
 * without its predecessor's session id. The session writes the file itself;
 * `scripts/build-state.js` creates or resumes it and prints its path.
 * Rooted on `hookStoreRoot()`, so the hook and a session's own Bash call in a
 * linked worktree name one file.
 */

const path = require("node:path");
const { hookStoreRoot } = require("./hook-store-root.js");

const BUILD_STATE_REL = path.join(".claude", "tmp", "build-state");

/** @param {number} issue */
function buildStateFile(issue) {
	return path.join(hookStoreRoot(), BUILD_STATE_REL, `${issue}.json`);
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
	/* Loaded here, not at the top: build-state.js's own CLI never reads the
	 * claims, and the claim store's module pulls in the liveness oracle. */
	const listed = require("./arbiter-issue-claims.js").listIssueClaims();
	const mine = (listed?.claims ?? []).filter(
		(c) => c?.sessionId === sid && typeof c.issue === "number",
	);
	mine.sort((a, b) => String(b.claimedAt).localeCompare(String(a.claimedAt)));
	return mine[0]?.issue ?? null;
}

module.exports = {
	buildStateFile,
	claimedIssue,
	newBuildState,
};
