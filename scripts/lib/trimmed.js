/** @param {unknown} value @returns {string} */
function trimmed(value) {
	return typeof value === "string" ? value.trim() : "";
}

module.exports = { trimmed };
