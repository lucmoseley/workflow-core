/*
 * first-line.js — the first line of a tool's output, for a one-line reason
 * (#2404).
 */

/** `text`'s first line, trimmed; empty where `text` is blank.
 *  @param {string} text */
function firstLine(text) {
	const trimmed = text.trim();
	const end = trimmed.indexOf("\n");
	return end === -1 ? trimmed : trimmed.slice(0, end);
}

module.exports = { firstLine };
