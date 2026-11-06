#!/usr/bin/env node
/*
 * inherited-roots.js — the root variables no `claude` the fleet launches may
 * inherit (#4595).
 *
 *   node scripts/lib/inherited-roots.js   prints them, space-separated, for
 *                                         a shell launcher's `env -u`
 *
 * A launcher runs under lib/refill-repos.js's buildCheckoutEnv, which pins
 * these to its own checkout for the scripts it starts. A `claude` handed them
 * keeps them: a `claude -p` session's hooks and Bash read them ahead of its
 * working directory, and a `claude` that starts the background daemon gives
 * them to every job the daemon later runs, in any repository. So the session
 * finds its root from its working directory and what the harness sets for
 * its hooks, as a job of a cleanly started daemon does.
 */

const { writeFd } = require("./write-fd.js");

const ROOT_VARS = Object.freeze([
	"WFC_REPO_ROOT",
	"CLAUDE_PROJECT_DIR",
	"WFC_DISPATCH_ROOT",
]);

/**
 * Strip the root variables from `env` in place.
 * @param {Record<string, string|undefined>} env
 */
function forgetRoots(env) {
	for (const v of ROOT_VARS) delete env[v];
}

if (require.main === module) writeFd(1, `${ROOT_VARS.join(" ")}\n`);

module.exports = { ROOT_VARS, forgetRoots };
