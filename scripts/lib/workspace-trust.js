const fs = require("node:fs");
const path = require("node:path");

/**
 * @param {string} seat
 * @param {string} dir
 */
function isUntrusted(seat, dir) {
	let projects;
	try {
		projects = JSON.parse(
			fs.readFileSync(path.join(seat, ".claude.json"), "utf8"),
		).projects;
	} catch {
		return false;
	}
	if (projects === null || typeof projects !== "object") return true;
	for (let at = path.resolve(dir); ; at = path.dirname(at)) {
		if (projects[at]?.hasTrustDialogAccepted === true) return false;
		if (path.dirname(at) === at) return true;
	}
}

module.exports = { isUntrusted };
