/*
 * refill-panel-view-env.js — an agents view's environment, for the panel beside it
 * (#3886). A pane `wsl.exe -e` opens starts no shell, so it has neither the view's
 * PATH nor its `WFC_CLAUDE_BIN` or `CLAUDE_CONFIG_DIR`, and a loop the panel restarted
 * would launch nothing. By hand, the shell running a command need not be the view's.
 */

const fs = require("node:fs");

/**
 * @param {number} pid
 * @param {(file: string) => string} [read]
 * @returns {Record<string, string>} empty where the system has no such file, so the caller keeps its own environment
 */
function readViewEnv(pid, read = (file) => fs.readFileSync(file, "utf8")) {
	let text;
	try {
		text = read(`/proc/${pid}/environ`);
	} catch {
		return {};
	}
	/** @type {Record<string, string>} */
	const env = {};
	for (const entry of text.split("\0")) {
		const at = entry.indexOf("=");
		if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
	}
	return env;
}

module.exports = { readViewEnv };
