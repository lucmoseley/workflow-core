const path = require("node:path");

/**
 * @param {string} p
 * @param {readonly string[]} roots
 * @param {string} [sep]
 * @returns {boolean}
 */
function isUnder(p, roots, sep = "/") {
	return roots.some((r) => p === r || p.startsWith(`${r}${sep}`));
}

/**
 * @param {string} root
 * @param {string} p
 * @returns {string | null}
 */
function relativeUnder(root, p) {
	const rel = path.relative(root, p);
	return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
		? null
		: rel;
}

module.exports = { isUnder, relativeUnder };
