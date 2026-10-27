/*
 * unchecked-rm-host.js — the production ports guard-rm-unchecked.js wires
 * into its core, lib/unchecked-rm.js (workflow-core#2801). The latch's key, read and write
 * are the kit's (lib/guard-entry.js); this answers only whether its directory
 * can be written.
 */

const fs = require("node:fs");
const { markersDir } = require("./marker-root.js");

/**
 * @param {import("./kit-context.js").PortEnv} env
 * @returns {import("./unchecked-rm.js").RmPorts}
 */
function buildHostPorts({ root }) {
	return {
		isLatchWritable: () => {
			try {
				fs.accessSync(markersDir(root), fs.constants.W_OK);
				return true;
			} catch {
				return false;
			}
		},
	};
}

module.exports = { buildHostPorts };
