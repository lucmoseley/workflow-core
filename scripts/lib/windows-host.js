const { runCommand } = require("./run-command.js");

const powershellBin = () =>
	process.env.WFC_POWERSHELL ||
	"/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

const schtasksBin = () =>
	process.env.WFC_SCHTASKS || "/mnt/c/Windows/System32/schtasks.exe";

/**
 * @param {string} name
 * @returns {string | null}
 */
const runTask = (name) =>
	runCommand(schtasksBin(), ["/Run", "/TN", name]).error;

/**
 * @param {"-w" | "-u"} way
 * @param {string} p
 * @returns {string}
 */
function wslpath(way, p) {
	const r = runCommand(process.env.WFC_WSLPATH || "wslpath", [way, p]);
	if (r.error !== null) throw new Error(r.error);
	return r.out;
}

/** @param {string} p */
const toWin = (p) => wslpath("-w", p);
/** @param {string} p */
const toWsl = (p) => wslpath("-u", p);

module.exports = { powershellBin, runTask, toWin, toWsl };
