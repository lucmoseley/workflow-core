const path = require("node:path");
const { machineMarkerPath } = require("./machine-marker.js");

const REFILL_STATE_FILE = ".refill-loop-state.json";
const OUTSIDE_FILE = ".refill-outside.json";

/** @param {string} name */
function refillPath(name) {
	return process.env.WFC_REFILL_DIR
		? path.join(process.env.WFC_REFILL_DIR, name)
		: machineMarkerPath(name, process.env);
}

module.exports = { OUTSIDE_FILE, REFILL_STATE_FILE, refillPath };
