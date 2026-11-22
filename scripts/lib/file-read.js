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

module.exports = { readBytes, readTail, readText };
