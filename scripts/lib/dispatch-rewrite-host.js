/*
 * dispatch-rewrite-host.js — the production ports lib/dispatch-rewrite.js
 * reads through the dispatcher (#2791): a fresh artefact path, its id drawn
 * at random; the making of its directory; and the model the dispatching
 * session runs on, off its transcript's tail (#4992).
 */

const { artefactFile } = require("./dispatch-artefact.js");
const { makeDir } = require("./guard-entry.js");
const { caught } = require("./caught.js");
const { readLastModel, resolve } = require("./session-transcript.js");

/**
 * @param {string} root
 * @param {(what: string) => void} [log]
 */
function buildHostPorts(root, log = () => undefined) {
	return {
		/** @param {unknown} description */
		artefactFile: (description) => artefactFile(root, description),
		makeDir,
		/** A lookup that throws reads as a model unknown, logged, so it costs
		 * the Fable pin and never the rest of the rewrite (#4992).
		 * @param {string} session */
		sessionModel: (session) => {
			if (!session) return "";
			try {
				const file = resolve({}, session);
				return file ? readLastModel(file) : "";
			} catch (e) {
				log(`session model unread — no Fable pin: ${caught(e).message}`);
				return "";
			}
		},
	};
}

module.exports = { buildHostPorts };
