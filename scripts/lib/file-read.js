/*
 * file-read.js — one read of a file that may be absent, told three ways:
 * absent (ENOENT alone), its contents, or unreadable with the error. Each
 * caller maps the three onto its own port's values, so no host hand-writes
 * the ENOENT catch (#3902). `readOrNull` is the same read through a tree's
 * port, where absent and unreadable both come back null. `readTail` is the
 * one read of a file's end, for a file too large to read whole (#4975).
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
 * The last `bytes` of a file as text, `partial` where they start mid-file, so
 * that their first line may be a line's tail. What to do with that line is
 * the caller's rule.
 * @param {string} file
 * @param {number} bytes
 * @returns {FileRead<{ text: string, partial: boolean }>}
 */
const readTail = (file, bytes) =>
	attempt(() => {
		const fd = fs.openSync(file, "r");
		try {
			const { size } = fs.fstatSync(fd);
			const start = Math.max(0, size - bytes);
			const buf = Buffer.alloc(size - start);
			const got = fs.readSync(fd, buf, 0, buf.length, start);
			return { text: buf.toString("utf8", 0, got), partial: start > 0 };
		} finally {
			fs.closeSync(fd);
		}
	});

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

module.exports = { readBytes, readOrNull, readTail, readText };
