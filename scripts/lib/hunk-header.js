/*
 * hunk-header.js — a diff hunk header, read and written in one place for the
 * mutation hold, the code-standards checker (#2379) and commit-paths'
 * --patch renumbering (#2486).
 */

const { requiredGroup } = require("./regex-group.js");

/* `@@ -old[,count] +new[,count] @@`, a count omitted where it is 1. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * @typedef {object} HunkHeader
 * @property {number} oldStart
 * @property {number} oldCount
 * @property {number} newStart
 * @property {number} newCount
 * @property {string} rest the text after the closing `@@`, section heading included
 */

/**
 * Both sides of a hunk header, or null where `line` is none.
 *
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
 * A header's text, a count of 1 omitted as git writes it.
 *
 * @param {HunkHeader} h
 * @returns {string}
 */
function formatHeader(h) {
	/** @type {(start: number, count: number) => string} */
	const side = (start, count) =>
		count === 1 ? `${start}` : `${start},${count}`;
	return `@@ -${side(h.oldStart, h.oldCount)} +${side(h.newStart, h.newCount)} @@${h.rest}`;
}

/**
 * The new-side start and line count of a hunk header, or null where `line`
 * is none. A pure deletion's count is 0.
 *
 * @param {string} line
 * @returns {{start: number, count: number} | null}
 */
function parseNewSide(line) {
	const h = parseHeader(line);
	return h === null ? null : { start: h.newStart, count: h.newCount };
}

module.exports = { formatHeader, parseHeader, parseNewSide };
