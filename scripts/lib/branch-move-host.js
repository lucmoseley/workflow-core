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
