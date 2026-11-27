const { gh } = require("./gh.js");

// 0.95–1.45 s measured, workflow-core#2792
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
				return null;
			}
		},
	};
}

module.exports = { buildHostPorts };
