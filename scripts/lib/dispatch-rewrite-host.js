const { artefactFile } = require("./dispatch-artefact.js");
const { makeDir } = require("./guard-entry.js");
const { caught } = require("./caught.js");
const { readLastModel, resolve } = require("./session-transcript.js");

/**
 * @param {{ root: string, log?: (what: string) => void }} env
 */
function buildHostPorts({ root, log = () => undefined }) {
	return {
		/** @param {unknown} description */
		artefactFile: (description) => artefactFile(root, description),
		makeDir,
		/** @param {string} session */
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
