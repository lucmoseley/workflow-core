/*
 * is-under.js — whether a path is one of a set of roots or sits beneath one
 * (#1647).
 *
 * A bare `startsWith(root)` is not a substitute: it reads `docsx/a` as under
 * `docs`.
 */

/**
 * @param {string} p relative or absolute, as the roots are
 * @param {readonly string[]} roots
 * @param {string} [sep] the separator `p` is spelt with
 * @returns {boolean}
 */
function isUnder(p, roots, sep = "/") {
	return roots.some((r) => p === r || p.startsWith(`${r}${sep}`));
}

module.exports = { isUnder };
