const fs = require("node:fs");
const path = require("node:path");

const HUSKY_LOOKUP = 's=$(dirname "$(dirname "$0")")/$n';
const OWN_LOOKUP = `t=$(git rev-parse --show-toplevel 2>/dev/null) && [ -f "$t/.husky/$n" ] && s="$t/.husky/$n" || ${HUSKY_LOOKUP}`;

/**
 * @param {string} commonDir
 * @returns {{ hooks: string, shim: string }}
 */
function shimPaths(commonDir) {
	const hooks = path.join(path.dirname(commonDir), ".husky", "_");
	return { hooks, shim: path.join(hooks, "h") };
}

/**
 * @param {string} shim
 * @returns {{ state: "absent" } | { state: "own" | "stock" | "unknown", body: string }}
 */
function readShim(shim) {
	if (!fs.existsSync(shim)) return { state: "absent" };
	const body = fs.readFileSync(shim, "utf8");
	if (body.includes(OWN_LOOKUP)) return { state: "own", body };
	return { state: body.includes(HUSKY_LOOKUP) ? "stock" : "unknown", body };
}

module.exports = { HUSKY_LOOKUP, OWN_LOOKUP, readShim, shimPaths };
