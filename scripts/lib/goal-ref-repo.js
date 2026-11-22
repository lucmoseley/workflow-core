const nodePath = require("node:path");
const { homeDir, readHostTracker } = require("./refill-repos.js");

/**
 * @param {import("./refill-goal.js").AskedRef} ref
 * @param {string|null} ownRepo
 * @param {string} hostRoot
 * @returns {string|null|undefined}
 */
function goalRefRepo(ref, ownRepo, hostRoot) {
	if (ref.repo === null || ref.repo === nodePath.basename(hostRoot))
		return ownRepo;
	return readHostTracker(nodePath.join(homeDir(), ref.repo)) ?? undefined;
}

module.exports = { goalRefRepo };
