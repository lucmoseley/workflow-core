const fs = require("node:fs");
const path = require("node:path");
const { isTerminalAgent, listedAgents } = require("./agent-liveness.js");
const { caught } = require("./caught.js");
const { markersDir, PASS_MARKER_PREFIXES } = require("./marker-root.js");

/**
 * @param {string} root
 * @param {string} from
 * @param {string} to
 * @returns {string|null}
 */
function movePassMarkers(root, from, to) {
	const dir = markersDir(root);
	const held = PASS_MARKER_PREFIXES.filter((p) =>
		fs.existsSync(path.join(dir, `${p}${from}`)),
	);
	if (held.length === 0) return null;
	const listed = listedAgents({ requireSelf: false });
	if (listed.why !== undefined) return listed.why;
	if (!listed.agents.some((a) => a.sessionId === to))
		return `the listing omits the copy ${to}, so it says nothing of ${from}`;
	const record = listed.agents.find((a) => a.sessionId === from);
	if (record && !isTerminalAgent(record)) return `${from} is still live`;
	for (const prefix of held) {
		const source = path.join(dir, `${prefix}${from}`);
		try {
			fs.linkSync(source, path.join(dir, `${prefix}${to}`));
		} catch (e) {
			if (caught(e).code !== "EEXIST") throw e;
		}
		fs.unlinkSync(source);
	}
	return null;
}

module.exports = { movePassMarkers };
