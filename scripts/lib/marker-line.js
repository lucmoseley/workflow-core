/**
 * @param {string} marker
 * @param {string} value
 * @param {string} [flags]
 * @param {string} [lead]
 */
const buildLineRe = (marker, value, flags = "m", lead = "") =>
	new RegExp(`^[ \\t]*${lead}\\*\\*${marker}:\\*\\*[ \\t]*${value}`, flags);

/**
 * @param {string} comment
 * @param {string} marker
 * @param {string} value
 */
const hasLine = (comment, marker, value) =>
	buildLineRe(marker, value).test(comment);

module.exports = { hasLine, buildLineRe };
