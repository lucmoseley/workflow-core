/*
 * issue-number.js — an issue number as a command line names it, `123` or
 * `#123`, for every script taking one (#3372).
 *
 * A CORE: it reads nothing but its arguments.
 */

/**
 * `value` as an issue number, `#` optional; null where it is not one.
 * @param {string|undefined} value
 * @returns {number|null}
 */
function parseIssueNumber(value) {
	const text = (value ?? "").trim();
	return /^#?\d+$/.test(text) ? Number(text.replace(/^#/, "")) : null;
}

/**
 * Each word of a comma- or space-separated list as parseIssueNumber reads it.
 * @param {string} text
 * @returns {(number|null)[]}
 */
const parseIssueNumbers = (text) =>
	text
		.split(/[,\s]+/)
		.filter(Boolean)
		.map(parseIssueNumber);

module.exports = { parseIssueNumber, parseIssueNumbers };
