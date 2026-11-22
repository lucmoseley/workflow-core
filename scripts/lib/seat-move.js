const fs = require("node:fs");
const path = require("node:path");
const { caught, ignoreFailure } = require("./caught.js");
const { transcriptPath } = require("./project-slug.js");

/**
 * @param {{from: string, to: string, sessionId: string, cwd: string}} move
 * @returns {string|null}
 */
function copyTranscript({ from, to, sessionId, cwd }) {
	const source = transcriptPath(from, cwd, sessionId);
	const dest = transcriptPath(to, cwd, sessionId);
	const partial = `${dest}.moving`;
	try {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(source, partial);
		fs.renameSync(partial, dest);
		return null;
	} catch (e) {
		ignoreFailure(() => fs.rmSync(partial, { force: true }));
		return `copying its transcript ${source} to ${to}: ${caught(e).message}`;
	}
}

module.exports = { copyTranscript };
