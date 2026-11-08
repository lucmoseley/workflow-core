/*
 * bracket-units.js — a glob-like pattern's characters, each closed `[…]` one
 * unit, read in one pass. The regex `/\[[^\]]*\]|./gs` re-reads the rest of
 * the input from every unclosed `[`, so a run of them costs seconds (workflow-core#3383).
 */

/**
 * @param {string} pattern
 * @returns {string[]}
 */
function bracketUnits(pattern) {
	const units = [];
	const lastClose = pattern.lastIndexOf("]");
	let i = 0;
	while (i < pattern.length) {
		const end =
			pattern[i] === "[" && i < lastClose ? pattern.indexOf("]", i) : i;
		units.push(pattern.slice(i, end + 1));
		i = end + 1;
	}
	return units;
}

module.exports = { bracketUnits };
