/*
 * hook-store-root.js — where a hook's stores live, read from any tree (#4410).
 *
 * `WFC_REPO_ROOT` first, as `lib/hook-block.js` reads it, else the main
 * checkout holding the host root, else the host root, so a script reading what
 * a hook wrote starts here. `hostRoot()` already re-points a declared linked
 * worktree at its main checkout (#4487); #4486 folds this helper into it.
 */

const { hostRoot } = require("./host-root.js");
const { mainCheckout } = require("./main-checkout.js");

/** @returns {string} */
function hookStoreRoot() {
	if (process.env.WFC_REPO_ROOT) return process.env.WFC_REPO_ROOT;
	const host = hostRoot();
	return mainCheckout(host) ?? host;
}

module.exports = { hookStoreRoot };
