/*
 * branch-publish-host.js — the production port lib/branch-publish.js reads
 * through the dispatcher (workflow-core#2792): the one `gh pr view` a `gh pr merge` naming
 * no `dependabot/` branch costs, run in the command's own directory under an
 * 8 s timeout, cut to what the dispatcher's budget leaves
 * (lib/hook-deadline.js).
 */

const { gh } = require("./gh.js");
const { budgetMs } = require("./hook-deadline.js");

const LOOKUP_TIMEOUT_MS = 8000;

/** @returns {import("./branch-publish.js").BranchPublishPorts} */
function buildHostPorts() {
	return {
		ghLookup: (cwd, args) => {
			try {
				return gh(args, {
					cwd,
					timeout: budgetMs(LOOKUP_TIMEOUT_MS),
					stdio: ["ignore", "pipe", "ignore"],
				});
			} catch {
				/* The port's contract: a lookup that could not run, timed out or
				 * exited non-zero answers null, which the core allows, recorded. */
				return null;
			}
		},
	};
}

module.exports = { buildHostPorts };
