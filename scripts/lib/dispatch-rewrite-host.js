/*
 * dispatch-rewrite-host.js — the production ports lib/dispatch-rewrite.js
 * reads through the dispatcher (#2791): a fresh artefact path, its id drawn
 * at random, and the making of its directory.
 */

const { artefactFile } = require("./dispatch-artefact.js");
const { makeDir } = require("./guard-entry.js");

/** @param {string} root */
function buildHostPorts(root) {
	return {
		/** @param {unknown} description */
		artefactFile: (description) => artefactFile(root, description),
		makeDir,
	};
}

module.exports = { buildHostPorts };
