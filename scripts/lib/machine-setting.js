/*
 * machine-setting.js — the one reader of a machine setting: an environment
 * variable where set, else the file `~/.claude/<name>`, shared by every repo's
 * sessions on the machine (#3228). The caller parses the text and keeps its
 * own default.
 */

const fs = require("node:fs");
const os = require("node:os");
const { caught } = require("./caught.js");
const { machineMarkerPath } = require("./machine-marker.js");

/**
 * The setting's raw text and where it came from: `envVar` where set, else the
 * file. An empty variable is no setting and skips the file, as is no file. A
 * file that will not read is no setting, and `problem` says why. `source`
 * names the variable or the file's path.
 *
 * Only the live environment falls back to the account's home; an injected one
 * names its own `HOME` or reads no file. A relative `HOME` reads no file.
 *
 * @param {string} name the file's name under `~/.claude`
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
