/*
 * registry-anchors-merge.js — the guard registry's anchors file merged per row
 * (#4171), for its git merge driver.
 *
 * A row both sides moved keeps the current side's digest. Neither side's is
 * an attestation of the merged content, so the gate names it stale and its
 * `--review` re-read writes the right one (#4167, #3935).
 */

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
 * The file's bytes as `check-guard-registry.js --review` writes them: rows
 * sorted by path, tab-indented, one trailing newline.
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

/**
 * The three-way merge of the file's three texts, or null where one is not a
 * JSON object of digests. A row only one side changed or deleted takes that
 * side; a row both changed keeps `ours`.
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
