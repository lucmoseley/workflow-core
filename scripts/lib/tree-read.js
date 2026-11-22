const { caught } = require("./caught.js");

/**
 * @param {Pick<import("./guard-host-ports.js").TreePorts, "readText">} tree
 * @param {string} rel
 * @returns {import("./file-read.js").FileRead<string>}
 */
function readTreeText(tree, rel) {
	try {
		const data = tree.readText(rel);
		return data === null ? { state: "absent" } : { state: "read", data };
	} catch (error) {
		return { state: "unreadable", error, message: caught(error).message };
	}
}

module.exports = { readTreeText };
