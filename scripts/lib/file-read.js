/*
 * file-read.js — one read of a file that may be absent, told three ways:
 * absent (ENOENT alone), its contents, or unreadable with the error. Each
 * caller maps the three onto its own port's values, so no host hand-writes
 * the ENOENT catch (workflow-core#3902).
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

module.exports = { readBytes, readText };
