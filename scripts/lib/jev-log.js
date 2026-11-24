const path = require("node:path");
const { markersDir } = require("./marker-root.js");

const LOG_NAME = ".jev-advisory-log.jsonl";
const LOG_PREVIOUS = ".jev-advisory-log.1.jsonl";

/**
 * @param {string} root
 * @returns {string}
 */
function logPath(root) {
	return path.join(markersDir(root), LOG_NAME);
}

/**
 * @param {string} root
 * @returns {string}
 */
function previousLogPath(root) {
	return path.join(markersDir(root), LOG_PREVIOUS);
}

/**
 * @param {{at?: unknown}} line
 * @returns {number|null}
 */
function whenOf(line) {
	if (typeof line.at !== "string") return null;
	const ms = Date.parse(line.at);
	return Number.isFinite(ms) ? ms : null;
}

module.exports = {
	logPath,
	previousLogPath,
	whenOf,
};
