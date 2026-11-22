/*
 * tracker-rules-host.js — the production port lib/tracker-rules.js reads
 * through the dispatcher (workflow-core#2792): a `gh issue comment` body file's text, for
 * the Blocked-comment row's read of what the comment opens with.
 */

const { readBodyFile } = require("./body-file.js");

function buildHostPorts() {
	return { readFile: readBodyFile };
}

module.exports = { buildHostPorts };
