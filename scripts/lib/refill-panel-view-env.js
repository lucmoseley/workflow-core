/*
 * refill-panel-view-env.js — an agents view's environment, for the panel beside it
 * (#3886). A pane `wsl.exe -e` opens starts no shell, so it has neither the view's
 * PATH nor its `WFC_CLAUDE_BIN` or `CLAUDE_CONFIG_DIR`, and a loop the panel restarted
 * would launch nothing. By hand, the shell running a command need not be the view's.
 * Its terminal's width, which stty reads, sizes the split (#3956).
 */

const { spawnSync } = require("node:child_process");
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

/**
 * The width of the terminal an agents view draws on. A view that has gone, or draws on no
 * terminal, still gets its panel: the caller says so, and sizes the split for a usual
 * window (#3956).
 * @param {number} pid
 * @param {(file: string) => string} [readLink]
 * @param {(tty: string) => string} [readSize] `stty size`'s output
 * @returns {number|null} null where the view draws on no terminal, or the size will not read
 */
function readViewColumns(
	pid,
	readLink = fs.readlinkSync,
	readSize = (tty) =>
		spawnSync("stty", ["-F", tty, "size"], { encoding: "utf8" }).stdout ?? "",
) {
	let tty;
	try {
		tty = readLink(`/proc/${pid}/fd/1`);
	} catch {
		return null;
	}
	if (!tty.startsWith("/dev/pts/")) return null;
	const columns = Number(readSize(tty).trim().split(" ")[1]);
	return columns > 0 ? columns : null;
}

module.exports = { readViewColumns, readViewEnv };
