/*
 * marker-line.js — whether a comment carries a `**Marker:**` line, the one
 * reading of a resolution line resolve-ticket.js and census-digest.js share
 * (#2376), and the pattern behind it for a reader that captures the value.
 */

/**
 * Spaces and tabs only around the marker: `\s` would cross a newline, passing
 * an empty line whose next line carries the value (#1750).
 * @param {string} marker a pattern too, inserted unescaped
 * @param {string} value a pattern the line must open with after the marker
 * @param {string} [flags]
 * @param {string} [lead] a pattern allowed before the marker's `**`
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
