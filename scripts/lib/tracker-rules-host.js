/*
 * tracker-rules-host.js — the production port lib/tracker-rules.js reads
 * through the dispatcher (#2792): a `gh issue comment` body file's text, for
 * the Blocked-comment row's read of what the comment opens with.
 */

const fs = require("node:fs");

function buildHostPorts() {
	return {
		/** @param {string} p @returns {string | undefined} */
		readFile: (p) =>
			fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined,
	};
}

module.exports = { buildHostPorts };
