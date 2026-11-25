const fs = require("node:fs");
const path = require("node:path");

/**
 * @param {string} p
 * @returns {string}
 */
function realpath(p) {
	const abs = path.isAbsolute(p) ? p : `${process.cwd()}/${p}`;
	let cur = "/";
	let missing = false;
	for (const part of abs.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			cur = path.dirname(cur);
			continue;
		}
		const next = path.join(cur, part);
		if (missing) {
			cur = next;
			continue;
		}
		try {
			cur = fs.realpathSync(next);
		} catch {
			missing = true;
			cur = next;
		}
	}
	return cur;
}

/** @returns {import("./recursive-dot-read.js").DotReadPorts} */
function buildHostPorts() {
	return { realpath };
}

module.exports = { buildHostPorts };
