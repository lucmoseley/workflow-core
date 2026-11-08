/*
 * move-pass-markers.js — hands a session's pass markers to the copy a refill-loop
 * resume starts, so the copy keeps the concision pass and the review it finished
 * under its old id (workflow-core#4105). Moved rather than copied, so concision-receipts.js
 * counts the pass once.
 *
 * Moved at the resume, and only then: a session still live at that moment has
 * branched from the copy, and whatever it writes later is its own work. A marker
 * the copy has already written beats the session's.
 */

const fs = require("node:fs");
const path = require("node:path");
const { isTerminalAgent, listedAgents } = require("./agent-liveness.js");
const { caught } = require("./caught.js");
const { markersDir, PASS_MARKER_PREFIXES } = require("./marker-root.js");

/**
 * Moves each pass marker session `from` holds in `root`'s store to session `to`,
 * unless `from` is live or whether it is cannot be read.
 * @param {string} root
 * @param {string} from
 * @param {string} to
 * @returns {string|null} why a marker `from` holds stayed, else null
 */
function movePassMarkers(root, from, to) {
	const dir = markersDir(root);
	const held = PASS_MARKER_PREFIXES.filter((p) =>
		fs.existsSync(path.join(dir, `${p}${from}`)),
	);
	if (held.length === 0) return null;
	/* Absence below reads as ended, so the self-test's check is made on the copy:
	 * a listing that omits it says nothing of `from`. A session running the tick
	 * is no party to this, so the caller's own self-test is waived. */
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
