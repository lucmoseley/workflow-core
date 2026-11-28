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
	if (projects === null || typeof projects !== "object") return false;
	const isTrusted = (/** @type {string} */ from) => {
		for (let at = from; ; at = path.dirname(at)) {
			if (projects[at]?.hasTrustDialogAccepted === true) return true;
			if (path.dirname(at) === at) return false;
		}
	};
	const resolved = path.resolve(dir);
	const real = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
	return !isTrusted(resolved) && !isTrusted(real);
}

module.exports = { isUntrusted };
