/*
 * branch-publish-host.js — the production port lib/branch-publish.js reads
 * through the dispatcher (#2792): the one `gh pr view` a `gh pr merge` naming
 * no `dependabot/` branch costs, run in the command's own directory under an
 * 8 s timeout, a guess over the 0.95–1.45 s five calls measured, which
 * lib/gh.js cuts to what the dispatcher's 30 s budget leaves.
 */

const { gh } = require("./gh.js");

const LOOKUP_TIMEOUT_MS = 8000;

/** @returns {import("./branch-publish.js").BranchPublishPorts} */
function buildHostPorts() {
	return {
		ghLookup: (cwd, args) => {
			try {
				return gh(args, {
					cwd,
					timeout: LOOKUP_TIMEOUT_MS,
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
