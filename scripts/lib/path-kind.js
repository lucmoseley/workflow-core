/*
 * path-kind.js — what stands at a path now (#4916): a file, a directory,
 * nothing, or something else. The read audit's preload records it for each
 * probe, through the `statSync` it saved before wrapping `fs`; its reader
 * asks it again of a script a child ran.
 */

const fs = require("node:fs");
const { caught } = require("./caught.js");

/**
 * @param {string} abs
 * @param {(p: string) => fs.Stats} [stat]
 * @returns {"file"|"dir"|"absent"|"other"}
 */
function pathKind(abs, stat = fs.statSync) {
	try {
		const st = stat(abs);
		if (st.isFile()) return "file";
		return st.isDirectory() ? "dir" : "other";
	} catch (e) {
		const code = caught(e).code;
		return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "other";
	}
}

module.exports = { pathKind };
