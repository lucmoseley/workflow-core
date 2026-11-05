/*
 * goal-ref-repo.js — the production checkout lookup lib/goal-set.js's
 * `resolveGoal` takes as its `repoOf` port: the `owner/name` a `--goal` ref
 * names, its `<dir>` a checkout's directory name under the home directory.
 *
 * An adapter: it reads `HOME` and each named checkout's
 * `.claude/workflow-core.json`. A module of its own so goal-set.test.ts runs
 * it for real against a temp HOME, not a fake (#4382, base §X11 condition 2).
 */

const nodePath = require("node:path");
const { homeDir, readHostTracker } = require("./refill-repos.js");

/**
 * @param {import("./refill-goal.js").AskedRef} ref
 * @param {string|null} ownRepo
 * @param {string} hostRoot the checkout the run serves, which a bare ref or one
 *   naming its own directory means
 * @returns {string|null|undefined} undefined where no checkout bears the name
 */
function goalRefRepo(ref, ownRepo, hostRoot) {
	if (ref.repo === null || ref.repo === nodePath.basename(hostRoot))
		return ownRepo;
	return readHostTracker(nodePath.join(homeDir(), ref.repo)) ?? undefined;
}

module.exports = { goalRefRepo };
