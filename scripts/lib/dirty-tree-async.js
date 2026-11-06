/*
 * dirty-tree-async.js — lib/dirty-tree.js's tracked-dirt read off the event
 * loop, so a caller can read many trees at once (#4542). Kept apart because
 * its spawn bypasses lib/git.js's memo, which every module the hook
 * dispatcher loads must go through (guard-dispatch-git-reads.test.ts).
 */

const { execGitAsync, GIT_TIMEOUT_MS } = require("./git.js");
const { parseTrackedStatus, TRACKED_STATUS } = require("./dirty-tree.js");

/**
 * @param {string} root
 * @returns {Promise<string[]|null>} null where git could not answer
 */
async function readDirtyTrackedAsync(root) {
	try {
		const { stdout } = await execGitAsync(TRACKED_STATUS, {
			cwd: root,
			timeout: GIT_TIMEOUT_MS,
		});
		return parseTrackedStatus(stdout).dirty;
	} catch {
		/* As readDirtyTracked: a tree git will not read is null, which the
		 * caller names as unread (#4542). */
		return null;
	}
}

module.exports = { readDirtyTrackedAsync };
