/*
 * trimmed.js — a value read off JSON or a tool payload as a trimmed string.
 */

/**
 * @param {unknown} value
 * @returns {string} the trimmed string, or "" for anything that is not one
 */
function trimmed(value) {
	return typeof value === "string" ? value.trim() : "";
}

module.exports = { trimmed };
