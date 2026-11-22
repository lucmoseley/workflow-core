const { buildAnchorsText, parseRows } = require("./registry-anchors-file.js");

/**
 * @param {string} base
 * @param {string} ours
 * @param {string} theirs
 * @returns {string|null}
 */
function buildMergedAnchors(base, ours, theirs) {
	const o = parseRows(base);
	const a = parseRows(ours);
	const b = parseRows(theirs);
	if (o === null || a === null || b === null) return null;
	/** @type {Record<string, string>} */
	const rows = {};
	for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
		const digest = a[key] === o[key] ? b[key] : a[key];
		if (digest !== undefined) rows[key] = digest;
	}
	return buildAnchorsText(rows);
}

module.exports = { buildMergedAnchors };
