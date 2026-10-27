/*
 * unasked-rerun-guard-host.js — the production ports guard-unasked-rerun.js
 * wires into its core, lib/unasked-rerun-guard.js (workflow-core#2800).
 *
 * The judge is lib/unasked-rerun.js's `judge`, called in process over
 * lib/unasked-rerun-io.js's ports at the kit's host root, each git call bounded
 * at the hook's git ceiling (workflow-core#2913), and both loaded only when a bare test
 * segment reaches it, so a command the core passes pays none of their requires.
 */

/**
 * @param {import("./kit-context.js").PortEnv} env
 * @returns {import("./unasked-rerun-guard.js").UnaskedPorts}
 */
function buildHostPorts({ root, payload }) {
	return {
		judge: (input) =>
			require("./unasked-rerun.js").judge(
				input,
				require("./unasked-rerun-io.js").judgeIO(root),
			),
		sessionId: typeof payload.session_id === "string" ? payload.session_id : "",
	};
}

module.exports = { buildHostPorts };
