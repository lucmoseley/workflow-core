/*
 * husky-shim.js — husky's generated `.husky/_/h` shim, and the lookup line
 * #3138 rewrites in it so a worktree's commit and push run that worktree's own
 * .husky/<hook> (#3172).
 */

const fs = require("node:fs");
const path = require("node:path");

const HUSKY_LOOKUP = 's=$(dirname "$(dirname "$0")")/$n';
const OWN_LOOKUP = `t=$(git rev-parse --show-toplevel 2>/dev/null) && [ -f "$t/.husky/$n" ] && s="$t/.husky/$n" || ${HUSKY_LOOKUP}`;

/**
 * The canonical checkout's shim, from the git common dir of any of its
 * worktrees: core.hooksPath names that checkout's .husky/_ from every one.
 * @param {string} commonDir
 * @returns {{ hooks: string, shim: string }}
 */
function shimPaths(commonDir) {
	const hooks = path.join(path.dirname(commonDir), ".husky", "_");
	return { hooks, shim: path.join(hooks, "h") };
}

/**
 * `own` carries #3138's lookup; `stock` is husky's, which install-hooks.js
 * rewrites; `unknown` carries neither, an upgraded husky's shim.
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
