/*
 * anthropic-report-host.js — the production ports the dispatcher wires into
 * the guard-anthropic-report core, lib/anthropic-report.js (#2798, #3224). The clone's remotes
 * are one git call per unnamed write, at the hook's git ceiling.
 */

const { gitOrNull, HOOK_GIT_TIMEOUT_MS } = require("./git.js");

/** @returns {import("./anthropic-report.js").ReportPorts} */
const buildHostPorts = () => ({
	remotes: (cwd) =>
		gitOrNull(["-C", cwd, "remote", "-v"], { timeout: HOOK_GIT_TIMEOUT_MS }) ??
		"",
});

module.exports = { buildHostPorts };
