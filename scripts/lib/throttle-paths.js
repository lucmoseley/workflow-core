const fs = require("node:fs");
const path = require("node:path");
const { machineMarkerPath } = require("./machine-marker.js");
const { markersDir } = require("./marker-root.js");
const { hostRoot } = require("./host-root.js");

/** @param {string} name @param {Record<string, string | undefined>} env @returns {string} */
function machineFile(name, env) {
	try {
		const file = machineMarkerPath(name, env);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		return file;
	} catch {
		return path.join(markersDir(hostRoot()), name);
	}
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
const stateFile = (env = process.env) =>
	env.WFC_THROTTLE_STATE || machineFile(".self-throttling-state.json", env);

/** @param {Record<string, string | undefined>} [env] @returns {string} */
const refreshStamp = (env = process.env) =>
	env.WFC_THROTTLE_REFRESH_STAMP || `${stateFile(env)}.refresh`;

// Claude Code deletes a transcript after `cleanupPeriodDays`, 30 by default. https://code.claude.com/docs/en/settings
/** @param {Record<string, string | undefined>} [env] @returns {string} */
const historyFile = (env = process.env) =>
	env.WFC_THROTTLE_HISTORY ||
	machineFile(".self-throttling-history.jsonl", env);

/** @param {Record<string, string | undefined>} [env] @returns {Record<string, string>} */
const throttleEnv = (env = process.env) => ({
	WFC_THROTTLE_STATE: stateFile(env),
	WFC_THROTTLE_REFRESH_STAMP: refreshStamp(env),
	WFC_THROTTLE_HISTORY: historyFile(env),
});

module.exports = { historyFile, refreshStamp, stateFile, throttleEnv };
