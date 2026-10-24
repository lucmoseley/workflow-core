/*
 * host-package.js — loads an npm package a shipped script needs from the host
 * repo's own install (#1380).
 *
 * The plugin cache carries no node_modules (lib/plugin-tree.js's header), so a
 * bare `require("<pkg>")` in a shipped script throws MODULE_NOT_FOUND in every
 * adopter. This resolves the package from the host root first, then from the
 * calling script's own directory, which finds the core's install in a core
 * checkout and nothing in the plugin cache.
 *
 * A MISSING PACKAGE IS AN OUTCOME, NOT A THROW (docs/code-standards-base.md
 * §T3): an adopter that has not installed it is expected, and the caller turns
 * the message into its own BROKEN, so the gate refuses rather than passing on
 * a check it never ran.
 */

const { hostRoot } = require("./host-root.js");

/**
 * @typedef {{ ok: true, module: any } | { ok: false, message: string }} Loaded
 * `module` is `any`: the package's own exports, which the caller narrows.
 */

/**
 * The package `name`, from the host repo's install or else the caller's own.
 *
 * @param {string} name the package, as `npm install` takes it
 * @param {string} callerDir the calling script's `__dirname`
 * @returns {Loaded}
 */
function hostPackage(name, callerDir) {
	const root = hostRoot();
	let resolved;
	try {
		resolved = require.resolve(name, { paths: [root, callerDir] });
	} catch {
		return {
			ok: false,
			message: `${name} is not installed in ${root}, so this check cannot run. Install it there: npm install --ignore-scripts --save-dev --save-exact ${name}`,
		};
	}
	return { ok: true, module: require(resolved) };
}

module.exports = { hostPackage };
