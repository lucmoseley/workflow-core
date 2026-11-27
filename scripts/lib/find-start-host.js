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
