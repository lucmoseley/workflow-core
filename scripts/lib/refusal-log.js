const fs = require("node:fs");
const path = require("node:path");
const { markersDir } = require("./marker-root.js");

/**
 * @param {string} root
 * @param {string} store
 * @returns {string}
 */
const logPath = (root, store) => path.join(markersDir(root), store);

/**
 * @template {{ at?: string, session: string, round: string, kind: string }} E
 * @param {string} root
 * @param {E[]} events
 * @param {string} store
 */
function appendEvents(root, events, store) {
	if (events.length === 0) return;
	const repo = path.basename(root);
	const now = new Date().toISOString();
	const lines = events.map(({ at = now, session, round, kind, ...rest }) =>
		JSON.stringify({ at, session, repo, round, kind, ...rest }),
	);
	fs.appendFileSync(logPath(root, store), `${lines.join("\n")}\n`);
}

module.exports = { logPath, appendEvents };
