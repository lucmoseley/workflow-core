/*
 * refill-dir.js — where the refill loop's machine-wide files live: the
 * machine markers directory (`~/.claude`, lib/machine-marker.js), or
 * `WFC_REFILL_DIR` where set. A leaf, so a module the loop's own readers
 * require can keep its files beside the loop's without a require cycle (workflow-core#2607).
 */

const path = require("node:path");
const { machineMarkerPath } = require("./machine-marker.js");

/** @param {string} name */
function refillPath(name) {
	return process.env.WFC_REFILL_DIR
		? path.join(process.env.WFC_REFILL_DIR, name)
		: machineMarkerPath(name, process.env);
}

module.exports = { refillPath };
