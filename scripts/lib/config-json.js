/*
 * config-json.js — serialises a JSON config file in the layout Biome's
 * formatter prints at its defaults with tab indent (workflow-core#675): objects expanded
 * one key per line, arrays inline where they fit in 80 columns. Plain
 * `JSON.stringify(v, null, "\t")` expands every array.
 *
 * Mirrors Biome's rules, not a general printer: a tab counts two columns; the
 * trailing comma counts towards the width; an array holding a non-empty object
 * always breaks; a breaking all-number array fills its lines. An adopter
 * whose Biome sets its own `lineWidth`, `indentWidth` or space indent is still
 * refused — both adopters run the defaults with tabs.
 */

const WIDTH = 80;
const TAB = 2;

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** @param {unknown} v @returns {boolean} */
function hasHardBreak(v) {
	if (isObject(v)) return Object.keys(v).length > 0;
	return Array.isArray(v) && v.some(hasHardBreak);
}

/** @param {unknown} v @returns {string} */
function inlineForm(v) {
	if (Array.isArray(v)) return `[${v.map(inlineForm).join(", ")}]`;
	return isObject(v) ? "{}" : JSON.stringify(v);
}

/**
 * @param {unknown} v
 * @param {number} depth
 * @param {number} used columns already on the line before `v`
 * @param {number} tail columns that follow `v` on its line
 * @returns {string}
 */
function printValue(v, depth, used, tail) {
	const inner = "\t".repeat(depth + 1);
	const close = "\t".repeat(depth);
	if (isObject(v)) {
		const keys = Object.keys(v);
		if (keys.length === 0) return "{}";
		const lines = keys.map((k, i) => {
			const last = i === keys.length - 1;
			const lead = `${JSON.stringify(k)}: `;
			const value = printValue(
				v[k],
				depth + 1,
				(depth + 1) * TAB + lead.length,
				last ? 0 : 1,
			);
			return `${inner}${lead}${value}${last ? "" : ","}`;
		});
		return `{\n${lines.join("\n")}\n${close}}`;
	}
	if (!Array.isArray(v)) return JSON.stringify(v);
	if (v.length === 0) return "[]";
	if (!hasHardBreak(v)) {
		const one = inlineForm(v);
		if (used + one.length + tail <= WIDTH) return one;
	}
	if (v.every((e) => typeof e === "number")) {
		const rows = [];
		let row = "";
		v.forEach((e, i) => {
			const item = `${JSON.stringify(e)}${i === v.length - 1 ? "" : ","}`;
			if (row && (depth + 1) * TAB + row.length + 1 + item.length > WIDTH) {
				rows.push(row);
				row = item;
			} else row = row ? `${row} ${item}` : item;
		});
		rows.push(row);
		return `[\n${rows.map((r) => inner + r).join("\n")}\n${close}]`;
	}
	const lines = v.map((e, i) => {
		const last = i === v.length - 1;
		return `${inner}${printValue(e, depth + 1, (depth + 1) * TAB, last ? 0 : 1)}${last ? "" : ","}`;
	});
	return `[\n${lines.join("\n")}\n${close}]`;
}

/**
 * @param {unknown} value
 * @returns {string} the file's whole text, trailing newline included
 */
function formatConfigJson(value) {
	return `${printValue(value, 0, 0, 0)}\n`;
}

module.exports = { formatConfigJson };
