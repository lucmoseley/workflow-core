const fs = require("node:fs");
const os = require("node:os");
const { caught } = require("./caught.js");
const { machineMarkerPath } = require("./machine-marker.js");

/**
 * @param {string} name
 * @param {string} envVar
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{text?: string, source?: string, problem?: string}}
 */
function readMachineSetting(name, envVar, env = process.env) {
	const value = env[envVar];
	if (value !== undefined)
		return value === "" ? {} : { text: value, source: envVar };
	const home = env.HOME || (env === process.env ? os.homedir() : "");
	let file;
	try {
		file = machineMarkerPath(name, { HOME: home });
	} catch {
		return {};
	}
	try {
		return { text: fs.readFileSync(file, "utf8"), source: file };
	} catch (e) {
		if (caught(e).code === "ENOENT") return {};
		return { problem: `${file}: ${caught(e).message}` };
	}
}

module.exports = { readMachineSetting };
