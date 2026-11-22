const path = require("node:path");
const { gitCommonDir } = require("./git.js");

/**
 * @param {string} common
 * @returns {string|null}
 */
function checkoutOfCommonDir(common) {
	return path.basename(common) === ".git" ? path.dirname(common) : null;
}

/**
 * @param {string} cwd
 * @returns {string|null}
 */
function mainCheckout(cwd) {
	const common = gitCommonDir(cwd);
	return common === null ? null : checkoutOfCommonDir(common);
}

module.exports = { checkoutOfCommonDir, mainCheckout };
