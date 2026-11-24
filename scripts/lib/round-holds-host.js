const { readBodyFile } = require("./body-file.js");
const os = require("node:os");
const { isMarkersWritable } = require("./refuse-once.js");

/**
 * @param {{ root: string }} env
 * @returns {import("./round-holds.js").RoundHoldPorts}
 */
function buildHostPorts({ root }) {
	return {
		home: os.homedir(),
		readFile: readBodyFile,
		isLatchWritable: () => isMarkersWritable(root),
		readHoldLines: () => {
			const holds = require("./repo-holds.js");
			return holds.buildHoldLines([holds.readCheckout(root)], Date.now());
		},
	};
}

module.exports = { buildHostPorts };
