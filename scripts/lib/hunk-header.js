const { requiredGroup } = require("./regex-group.js");

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * @typedef {object} HunkHeader
 * @property {number} oldStart
 * @property {number} oldCount
 * @property {number} newStart
 * @property {number} newCount
 * @property {string} rest
 */

/**
 * @param {string} line
 * @returns {HunkHeader | null}
 */
function parseHeader(line) {
	const m = HUNK_HEADER.exec(line);
	if (m === null) return null;
	return {
		oldStart: Number(requiredGroup(m, 1, HUNK_HEADER)),
		oldCount: m[2] === undefined ? 1 : Number(m[2]),
		newStart: Number(requiredGroup(m, 3, HUNK_HEADER)),
		newCount: m[4] === undefined ? 1 : Number(m[4]),
		rest: line.slice(m[0].length),
	};
}

/**
 * @param {HunkHeader} h
 * @returns {string}
 */
function formatHeader(h) {
	return `@@ -${formatSide(h.oldStart, h.oldCount)} +${formatSide(h.newStart, h.newCount)} @@${h.rest}`;
}

/** @type {(start: number, count: number) => string} */
const formatSide = (start, count) =>
	count === 1 ? `${start}` : `${start},${count}`;

/**
 * @param {string} line
 * @returns {{start: number, count: number} | null}
 */
function parseNewSide(line) {
	const h = parseHeader(line);
	return h === null ? null : { start: h.newStart, count: h.newCount };
}

module.exports = { formatHeader, formatSide, parseHeader, parseNewSide };
