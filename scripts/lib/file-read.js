/*
 * file-read.js — one read of a file that may be absent, told three ways:
 * absent (ENOENT alone), its contents, or unreadable with the error. Each
 * caller maps the three onto its own port's values, so no host hand-writes
 * the ENOENT catch (#3902).
 */

const fs = require("node:fs");
const { caught } = require("./caught.js");

/**
 * @template T
 * @typedef {{ state: "absent" }
 *   | { state: "read", data: T }
 *   | { state: "unreadable", error: unknown, message: string }} FileRead
 */

/**
 * @template T
 * @param {() => T} read
 * @returns {FileRead<T>}
 */
function attempt(read) {
	try {
		return { state: "read", data: read() };
	} catch (error) {
		const { code, message } = caught(error);
		return code === "ENOENT"
			? { state: "absent" }
			: { state: "unreadable", error, message };
	}
}

/**
 * @param {string} file
 * @returns {FileRead<string>}
 */
const readText = (file) => attempt(() => fs.readFileSync(file, "utf8"));

/**
 * @param {string} file
 * @returns {FileRead<Buffer>}
 */
const readBytes = (file) => attempt(() => fs.readFileSync(file));

/**
 * The readFile port a guard host hands a core that reads a `gh` call's
 * --body-file (lib/gh-body.js): the text, undefined where absent; it throws
 * where the file cannot be read.
 *
 * @param {string} file
 * @returns {string | undefined}
 */
function readBodyFile(file) {
	const got = readText(file);
	if (got.state === "unreadable") throw got.error;
	return got.state === "read" ? got.data : undefined;
}

module.exports = { readBodyFile, readBytes, readText };
