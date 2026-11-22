const { execGitAsync, GIT_TIMEOUT_MS } = require("./git.js");
const { parseTrackedStatus, TRACKED_STATUS } = require("./dirty-tree.js");

/**
 * @param {string} root
 * @returns {Promise<string[]|null>}
 */
async function readDirtyTrackedAsync(root) {
	try {
		const { stdout } = await execGitAsync(TRACKED_STATUS, {
			cwd: root,
			timeout: GIT_TIMEOUT_MS,
		});
		return parseTrackedStatus(stdout).dirty;
	} catch {
		return null;
	}
}

module.exports = { readDirtyTrackedAsync };
