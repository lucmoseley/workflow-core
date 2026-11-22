const { isMarkersWritable } = require("./refuse-once.js");

/**
 * @param {{ root: string }} env
 * @returns {import("./unchecked-rm.js").RmPorts}
 */
function buildHostPorts({ root }) {
	return {
		isLatchWritable: () => isMarkersWritable(root),
	};
}

module.exports = { buildHostPorts };
