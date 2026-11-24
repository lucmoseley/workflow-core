class RegexGroupMissingError extends Error {
	/**
	 * @param {number} group
	 * @param {string} pattern
	 */
	constructor(group, pattern) {
		super(
			`capture group ${group} did not participate in a match of /${pattern}/`,
		);
		this.name = "RegexGroupMissingError";
		this.group = group;
		this.pattern = pattern;
	}
}

/**
 * @param {RegExpMatchArray | RegExpExecArray} m
 * @param {number} n
 * @param {RegExp} re
 * @returns {string}
 */
function requiredGroup(m, n, re) {
	const g = m[n];
	if (g === undefined) throw new RegexGroupMissingError(n, re.source);
	return g;
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

module.exports = { escapeRe, requiredGroup };
