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
 *
 * THE TOLERANT READER IS HERE because three files now need it and read the
 * same bytes — `check-jev-flags.js`, `jev-verdict.js` and `jev-trial.js`.
 */

const fs = require("node:fs");
const path = require("node:path");
const { markersDir } = require("./marker-root.js");
const { caught } = require("./caught.js");

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
 * Every parseable line in `file`, in file order, with the unparseable ones
 * counted rather than thrown on: a line half-written when a process died, or
 * a tail torn by a rotation mid-append, must not hide the lines around it.
 *
 * NULL WHERE THE FILE IS ABSENT — nothing has been written here yet, which is
 * an empty sample. A file that exists and will not read THROWS, so a
 * permissions fault can be told apart from a first run.
 *
 * @param {string} file
 * @returns {{lines: Record<string, unknown>[], torn: number}|null}
 */
function readJsonl(file) {
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (caught(e).code === "ENOENT") return null;
		throw e;
	}
	/** @type {Record<string, unknown>[]} */
	const lines = [];
	let torn = 0;
	for (const text of raw.split("\n")) {
		if (!text.trim()) continue;
		try {
			lines.push(JSON.parse(text));
		} catch {
			torn++;
		}
	}
	return { lines, torn };
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
	readJsonl,
	whenOf,
};
