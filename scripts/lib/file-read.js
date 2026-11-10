/*
 * file-read.js — one read of a file that may be absent, told three ways:
 * absent (ENOENT alone), its contents, or unreadable with the error. Each
 * caller maps the three onto its own port's values, so no host hand-writes
 * the ENOENT catch (#3902). `readOrNull` is the same read through a tree's
 * port, where absent and unreadable both come back null.
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
 * A file's text in `tree`, null where it is absent or will not read: the
 * fail-open read of a core that allows, logged, on either (mantahostels#103
 * §6, #4132).
 * @param {Pick<import("./guard-host-ports.js").TreePorts, "readText">} tree
 * @param {string} rel
 * @returns {string | null}
 */
function readOrNull(tree, rel) {
	try {
		return tree.readText(rel);
	} catch {
		return null;
	}
}

module.exports = { readBytes, readOrNull, readText };
