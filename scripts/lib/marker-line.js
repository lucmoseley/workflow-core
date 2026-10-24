/*
 * marker-line.js — whether a comment carries a `**Marker:**` line, the one
 * reading of a resolution line resolve-ticket.js and census-digest.js share
 * (#2376).
 */

/**
 * Spaces and tabs only around the marker: `\s` would cross a newline, passing
 * an empty line whose next line carries the value (#1750).
 * @param {string} comment
 * @param {string} marker a pattern too, inserted unescaped
 * @param {string} value a pattern the line must open with after the marker
 */
const hasLine = (comment, marker, value) =>
	new RegExp(`^[ \\t]*\\*\\*${marker}:\\*\\*[ \\t]*${value}`, "m").test(
		comment,
	);

module.exports = { hasLine };
