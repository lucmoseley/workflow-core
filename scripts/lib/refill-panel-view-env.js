const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

/**
 * @param {number} pid
 * @param {(file: string) => string} [read]
 * @returns {Record<string, string>}
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
 * @param {number} pid
 * @param {(file: string) => string} [readLink]
 * @param {(tty: string) => string} [readSize]
 * @returns {number|null}
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
