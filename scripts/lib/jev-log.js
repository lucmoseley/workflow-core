/*
 * jev-log.js — where the Jev advisory guard's JSONL log lives, named once.
 *
 * #175's stop condition is counted from this file and from nothing else, and
 * two scripts now need to agree on it: `guard-jev-advisory.js` appends to it
 * (#203) and `check-jev-flags.js` reads it back at session start (#202).
 *
 * ROTATION, not truncation: `LOG_PREVIOUS` is where a full log is moved, so
 * one rotation's worth of history survives. A reader that has not reported
 * everything in the live log must look there too.
 *
 * The outcome vocabulary is NOT here. Each side declares the outcomes it
 * handles, which are different sets: the guard may only write what it can
 * produce, and the reader reports the two that reach the founder's screen.
 */

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
 * A line's `at` as epoch milliseconds, or null where it carries none that
 * parses.
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
