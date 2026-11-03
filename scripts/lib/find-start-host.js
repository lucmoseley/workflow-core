/*
 * find-start-host.js — the production ports the dispatcher wires into the
 * guard-root-find core, lib/find-start.js (workflow-core#2801, workflow-core#3227): the plugin's own
 * root, resolved physical (symlinks followed).
 */

const fs = require("node:fs");
const { coreRoot } = require("./script-path.js");

/** @returns {import("./find-start.js").FindStartPorts} */
function buildHostPorts() {
	return {
		pluginRoot: () => {
			try {
				return fs.realpathSync(coreRoot());
			} catch {
				return null;
			}
		},
	};
}

module.exports = { buildHostPorts };
