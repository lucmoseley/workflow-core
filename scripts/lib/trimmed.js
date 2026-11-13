/*
 * trimmed.js — a value read off JSON or a tool payload as a trimmed string,
 * "" for anything that is not one. lib/model-table.js reads an `Agent` call's
 * fields and lib/burn-mode.js a plan's settings `model` through it, so a
 * missing or non-string field reads as none in both (workflow-core#4920).
 */

/**
 * @param {unknown} value
 * @returns {string} the trimmed string, or "" for anything that is not one
 */
function trimmed(value) {
	return typeof value === "string" ? value.trim() : "";
}

module.exports = { trimmed };
