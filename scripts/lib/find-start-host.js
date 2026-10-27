/*
 * find-start-host.js — the production ports guard-root-find.js wires into its
 * core, lib/find-start.js (#2801): the plugin's own root, resolved physical
 * (symlinks followed), and the install's core-path rewrite.
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
