/*
 * load-text-module.js — evaluates a copy of lib/tracker-inject-text.js handed
 * over as source text, so a revision's blob read out of git, or a materialised
 * tree's copy, can be measured where its siblings are absent (#5151).
 *
 * The sandbox gives the module `module` and `exports` and nothing else: no
 * `require`, no `process`, no filesystem. The text module requires nothing,
 * so a copy that reaches for any of them throws here rather than running.
 */

const vm = require("node:vm");

/* The text module's repo-relative path: the name each reader quotes, and the
 * path it is materialised at. */
const TRACKER_TEXT = "scripts/lib/tracker-inject-text.js";

/* A hung copy is BROKEN. */
const EVAL_TIMEOUT_MS = 2000;

/**
 * The exports of a tracker-inject-text.js source.
 * @param {string} source the file's text
 * @param {string} filename named in a stack trace
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
