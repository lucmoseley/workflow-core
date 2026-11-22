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
