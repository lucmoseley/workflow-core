/*
 * branch-move-host.js — the production ports the dispatcher wires into the
 * guard-branch core, lib/branch-move.js (#2797, #3224). The one git read carries the hook's git
 * timeout, and a timed-out read answers as an erroring one: no such branch.
 */

const fs = require("node:fs");
const { gitOrNull, HOOK_GIT_TIMEOUT_MS } = require("./git.js");

/** @returns {import("./branch-move.js").BranchPorts} */
function buildHostPorts() {
	return {
		isBranch: (dir, name) =>
			gitOrNull(
				["-C", dir, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`],
				{ timeout: HOOK_GIT_TIMEOUT_MS },
			) !== null,
		exists: (p) => fs.existsSync(p),
	};
}

module.exports = { buildHostPorts };
