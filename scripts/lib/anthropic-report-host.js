const { gitOrNull, HOOK_GIT_TIMEOUT_MS } = require("./git.js");

/** @returns {import("./anthropic-report.js").ReportPorts} */
const buildHostPorts = () => ({
	remotes: (cwd) =>
		gitOrNull(["-C", cwd, "remote", "-v"], { timeout: HOOK_GIT_TIMEOUT_MS }) ??
		"",
});

module.exports = { buildHostPorts };
