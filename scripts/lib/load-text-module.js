const vm = require("node:vm");

const TRACKER_TEXT = "scripts/lib/tracker-inject-text.js";

// guess, #5151
const EVAL_TIMEOUT_MS = 2000;

/**
 * @param {string} source
 * @param {string} filename
 * @returns {Record<string, unknown>}
 */
function loadTextModule(source, filename) {
	const module = { exports: /** @type {Record<string, unknown>} */ ({}) };
	vm.runInNewContext(
		source,
		{ module, exports: module.exports },
		{ filename, timeout: EVAL_TIMEOUT_MS },
	);
	return module.exports;
}

module.exports = { TRACKER_TEXT, loadTextModule };
