/*
 * main-checkout.js — which checkout git's common dir names (workflow-core#2563).
 *
 * A common dir named `.git` names its parent; any other, a submodule's or a
 * `--separate-git-dir` one, names no checkout. One home for the rule, so its
 * callers cannot drift. DUPLICATED BY HAND in self-plugin-canary.sh, which
 * runs with no node. resolve-core.js's `adopterRoot` (FROZEN, builtins-only)
 * keeps a variant that falls back to the toplevel.
 */

const { execFileSync } = require("node:child_process");
const path = require("node:path");

/**
 * @param {string} common an absolute git common dir
 * @returns {string|null}
 */
function checkoutOfCommonDir(common) {
	return path.basename(common) === ".git" ? path.dirname(common) : null;
}

/**
 * The main checkout holding `cwd`, never a linked worktree — or null where git
 * will not say, or where the common dir names no checkout.
 * @param {string} cwd
 * @returns {string|null}
 */
function mainCheckout(cwd) {
	let common;
	try {
		common = execFileSync(
			"git",
			["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
	} catch {
		return null;
	}
	return checkoutOfCommonDir(common);
}

module.exports = { checkoutOfCommonDir, mainCheckout };
