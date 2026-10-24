/*
 * regex-group.js — reads a capture group the pattern guarantees is present
 * (#1336, #1341).
 *
 * Under `noUncheckedIndexedAccess` every `m[1]` is `string | undefined`. Where
 * the group sits on every path through the pattern, a match without it is a
 * broken invariant, so this throws (docs/code-standards-base.md §T3) rather than
 * letting `undefined` run on as a string.
 *
 * NOT FOR AN OPTIONAL GROUP — `(…)?`, or one branch of an alternation. There
 * absence is a real outcome, and the caller tests the `string | undefined`
 * itself. Whether the match succeeded at all stays the caller's test too: a
 * non-match is usually an expected result, not a breach.
 */

/** A group the pattern promised did not participate in the match. */
class RegexGroupMissingError extends Error {
	/**
	 * @param {number} group
	 * @param {string} pattern the pattern's source
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
 * The string capture group `n` matched.
 *
 * @param {RegExpMatchArray | RegExpExecArray} m a successful match
 * @param {number} n
 * @param {RegExp} re the pattern `m` came from, for the error to name
 * @returns {string}
 * @throws {RegexGroupMissingError} when group `n` did not participate
 */
function requiredGroup(m, n, re) {
	const g = m[n];
	if (g === undefined) throw new RegexGroupMissingError(n, re.source);
	return g;
}

module.exports = { requiredGroup };
