/*
 * compare-versions.js — the one version comparer (#4091). Each caller parses
 * and shape-checks its own versions; this only orders the parts.
 */

/**
 * Negative where `a` is the earlier version, positive where later, 0 where
 * equal: numeric by component, a missing component reading 0.
 * @param {number[]} a
 * @param {number[]} b
 */
function compareVersions(a, b) {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

module.exports = { compareVersions };
