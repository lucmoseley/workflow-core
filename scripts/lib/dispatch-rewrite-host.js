/*
 * dispatch-rewrite-host.js — the production ports lib/dispatch-rewrite.js
 * reads through the dispatcher (#2791): a fresh artefact path, its id drawn
 * at random; the making of its directory; and the model the dispatching
 * session runs on, off its transcript's tail (#4992).
 */

const { artefactFile } = require("./dispatch-artefact.js");
const { makeDir } = require("./guard-entry.js");
const { lastModel, resolve } = require("./session-transcript.js");

/** @param {string} root */
function buildHostPorts(root) {
	return {
		/** @param {unknown} description */
		artefactFile: (description) => artefactFile(root, description),
		makeDir,
		/** @param {string} session */
		sessionModel: (session) => {
			if (!session) return "";
			const file = resolve({}, session);
			return file ? lastModel(file) : "";
		},
	};
}

module.exports = { buildHostPorts };
