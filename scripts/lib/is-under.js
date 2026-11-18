/*
 * is-under.js — whether a path is one of a set of roots or sits beneath one
 * (workflow-core#1647), and the same question asked of a root and an absolute path (workflow-core#4021).
 *
 * A bare `startsWith(root)` is not a substitute: it reads `docsx/a` as under
 * `docs`. Nor is a relative path's leading `..` alone: a file named `..foo`
 * inside the root would read as outside.
 */

const path = require("node:path");

/**
 * @param {string} p relative or absolute, as the roots are
 * @param {readonly string[]} roots
 * @param {string} [sep] the separator `p` is spelt with
 * @returns {boolean}
 */
function isUnder(p, roots, sep = "/") {
	return roots.some((r) => p === r || p.startsWith(`${r}${sep}`));
}

/**
 * `p` relative to `root`, in the platform's separator, where `p` is `root`
 * (`""`) or sits beneath it; null where it lies outside, another drive
 * included. Strictly beneath is a truthy answer. No I/O: a caller comparing
 * real paths resolves both first.
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
