/*
 * unasked-rerun-guard-host.js — the production ports the dispatcher wires into
 * the guard-unasked-rerun core, lib/unasked-rerun-guard.js (#2800, #3227).
 *
 * The judge is lib/unasked-rerun.js's `judge`, called in process over
 * lib/unasked-rerun-io.js's ports — the stores at the kit's host root, HEAD
 * and own work in the session's tree the core hands in (#4242) — each git call
 * bounded at the hook's git ceiling (#2913), and both loaded only when a bare
 * test segment reaches it, so a command the core passes pays none of their
 * requires.
 */

/**
 * @param {string} root
 * @returns {import("./unasked-rerun-guard.js").UnaskedPorts}
 */
function buildHostPorts(root) {
	return {
		judge: (input, tree) =>
			require("./unasked-rerun.js").judge(
				input,
				require("./unasked-rerun-io.js").judgeIO(root, { tree }),
			),
	};
}

module.exports = { buildHostPorts };
