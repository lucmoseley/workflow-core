/**
 * @param {string|undefined} value
 * @returns {number|null}
 */
function parseIssueNumber(value) {
	const text = (value ?? "").trim();
	return /^#?\d+$/.test(text) ? Number(text.replace(/^#/, "")) : null;
}

/**
 * @param {string} text
 * @returns {(number|null)[]}
 */
const parseIssueNumbers = (text) =>
	text
		.split(/[,\s]+/)
		.filter(Boolean)
		.map(parseIssueNumber);

module.exports = { parseIssueNumber, parseIssueNumbers };
