const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runCommand } = require("./run-command.js");
const { systemctl } = require("./systemd-bins.js");

const PLAIN_PATH = /^[\w./@+-]+$/;

/**
 * @param {string[]} words
 * @returns {string|null}
 */
const unquotableWord = (words) =>
	words.find((w) => !PLAIN_PATH.test(w)) ?? null;

/**
 * @param {string} name
 * @param {string} value
 */
function buildEnvironmentLine(name, value) {
	const escaped = value
		.replace(/[\\"]/g, "\\$&")
		.replace(/%/g, "%%")
		.replace(/\$/g, "$$$$");
	return `Environment="${name}=${escaped}"`;
}

const userUnitDir = () =>
	path.join(
		process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
		"systemd",
		"user",
	);

/**
 * @param {Record<string, string>} units
 * @returns {string}
 */
function writeUserUnits(units) {
	const dir = userUnitDir();
	fs.mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(units))
		fs.writeFileSync(path.join(dir, name), text);
	return dir;
}

/**
 * @param {{unit: string, now: boolean}[]} enables
 * @returns {ReturnType<typeof runCommand>[]}
 */
function enableUserUnits(enables) {
	const reload = runCommand(systemctl(), ["--user", "daemon-reload"]);
	return enables.map(({ unit, now }) =>
		reload.error
			? reload
			: runCommand(systemctl(), [
					"--user",
					"enable",
					...(now ? ["--now"] : []),
					unit,
				]),
	);
}

module.exports = {
	buildEnvironmentLine,
	enableUserUnits,
	unquotableWord,
	userUnitDir,
	writeUserUnits,
};
