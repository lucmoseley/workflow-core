/*
 * marker-line.js — whether a comment carries a `**Marker:**` line, the one
 * reading of a resolution line resolve-ticket.js and census-digest.js share
 * (#2376).
 */

/**
 * Spaces and tabs only around the marker: `\s` would cross a newline, passing
 * an empty line whose next line carries the value (#1750).
 * @param {string} marker a pattern too, inserted unescaped
 * @param {string} value a pattern the line must open with after the marker
 * @param {string} [flags]
 */
const lineRe = (marker, value, flags = "m") =>
	new RegExp(`^[ \\t]*\\*\\*${marker}:\\*\\*[ \\t]*${value}`, flags);

/**
 * @param {string} comment
 * @param {string} marker
 * @param {string} value
 */
const hasLine = (comment, marker, value) => lineRe(marker, value).test(comment);

module.exports = { hasLine, lineRe };
