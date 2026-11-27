const fs = require("node:fs");
const path = require("node:path");

const ANCHORS = ".claude/guard-registry-anchors.json";

const IMPLICIT_MANIFEST = ".claude/implicit-behaviours.json";

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

/** @param {Record<string, string>} rows */
function buildAnchorsText(rows) {
	const sorted = Object.fromEntries(
		Object.keys(rows)
			.sort()
			.map((k) => [k, rows[k]]),
	);
	return `${JSON.stringify(sorted, null, "\t")}\n`;
}

/** @type {Map<string, { text: string, rows: Record<string, unknown> }>} */
const manifestCache = new Map();

/**
 * @param {string} base
 * @param {string} rel
 * @returns {Record<string, unknown> | null}
 */
function implicitRowIn(base, rel) {
	let text;
	try {
		text = fs.readFileSync(path.join(base, IMPLICIT_MANIFEST), "utf8");
	} catch {
		return null;
	}
	let known = manifestCache.get(base);
	if (known?.text !== text) {
		known = { text, rows: parseManifest(text) };
		manifestCache.set(base, known);
	}
	const row = known.rows[rel];
	return row !== null && typeof row === "object"
		? /** @type {Record<string, unknown>} */ (row)
		: null;
}

/**
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
function parseManifest(text) {
	try {
		const v = JSON.parse(text);
		return v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
	} catch {
		return {};
	}
}

module.exports = {
	ANCHORS,
	IMPLICIT_MANIFEST,
	buildAnchorsText,
	implicitRowIn,
	parseRows,
};
