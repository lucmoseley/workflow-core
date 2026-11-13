/*
 * registry-anchors-file.js — the guard registry's anchors file: where it
 * lives, host data under the host's .claude/ (workflow-core#37), and its one reader and
 * one writer, so every writer of it lays down the same bytes (workflow-core#4177).
 */
const ANCHORS = ".claude/guard-registry-anchors.json";

/** @param {unknown} v @returns {v is Record<string, string>} */
const isRows = (v) =>
	v !== null &&
	typeof v === "object" &&
	!Array.isArray(v) &&
	Object.values(v).every((d) => typeof d === "string");

/**
 * @param {string} text
 * @returns {Record<string, string>|null}
 */
function parseRows(text) {
	try {
		const v = JSON.parse(text);
		return isRows(v) ? v : null;
	} catch {
		return null;
	}
}

/**
 * Rows sorted by path, tab-indented, one trailing newline.
 * @param {Record<string, string>} rows
 */
function buildAnchorsText(rows) {
	const sorted = Object.fromEntries(
		Object.keys(rows)
			.sort()
			.map((k) => [k, rows[k]]),
	);
	return `${JSON.stringify(sorted, null, "\t")}\n`;
}

module.exports = { ANCHORS, buildAnchorsText, parseRows };
