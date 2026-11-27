const { hostRoot } = require("./host-root.js");

/**
 * @typedef {{ ok: true, module: any } | { ok: false, message: string }} Loaded
 */

/**
 * @param {string} name
 * @param {string} callerDir
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
