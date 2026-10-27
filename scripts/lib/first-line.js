/*
 * first-line.js — the first line of a tool's output (#2404) or of a thrown
 * error's message (#2728), for a one-line reason.
 */

const { caught } = require("./caught.js");

/** `text`'s first line, trimmed; empty where `text` is blank.
 *  @param {string} text */
function parseFirstLine(text) {
	const trimmed = text.trim();
	const end = trimmed.indexOf("\n");
	return end === -1 ? trimmed : trimmed.slice(0, end);
}

/** The first line of `e`'s message, whatever was thrown.
 *  @param {unknown} e */
const parseErrorFirstLine = (e) => parseFirstLine(caught(e).message);

module.exports = { parseErrorFirstLine, parseFirstLine };
