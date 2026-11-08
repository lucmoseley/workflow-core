/*
 * unchecked-rm-host.js — the production ports the dispatcher wires into the
 * guard-rm-unchecked core, lib/unchecked-rm.js (workflow-core#2801, workflow-core#3226). The latch's
 * key, read and write are the kit's (lib/kit-context.js); this answers only whether its directory
 * can be written.
 */

const { isMarkersWritable } = require("./refuse-once.js");

/**
 * @param {string} root
 * @returns {import("./unchecked-rm.js").RmPorts}
 */
function buildHostPorts(root) {
	return {
		isLatchWritable: () => isMarkersWritable(root),
	};
}

module.exports = { buildHostPorts };
