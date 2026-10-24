/*
 * by-code-unit.js — a three-way string comparator for `sort` (workflow-core#1508).
 *
 * It orders by UTF-16 code unit, as `<` and a bare `sort()` do. `localeCompare`
 * is not a substitute: it folds case and accents, so a caller's order would
 * change.
 */

/**
 * -1, 1 or 0 as `a` sorts before, after or level with `b`.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function byCodeUnit(a, b) {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

module.exports = { byCodeUnit };
