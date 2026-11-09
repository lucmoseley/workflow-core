/*
 * line-terminators.js — the characters a regex's `.` and `$` (under `m`) stop
 * at: ECMAScript's LineTerminator set. For code that reads a line by index
 * where a regex would have kept `.` from crossing one (#4647).
 */

const LINE_TERMINATORS = ["\n", "\r", "\u2028", "\u2029"];

/** Whether `text` holds a line terminator. */
const hasLineTerminator = (/** @type {string} */ text) =>
	LINE_TERMINATORS.some((c) => text.includes(c));

/** Where `text`'s first line terminator is, or its length where it has none. */
const firstLineTerminator = (/** @type {string} */ text) =>
	Math.min(
		text.length,
		...LINE_TERMINATORS.map((c) => text.indexOf(c)).filter((i) => i !== -1),
	);

/** Where `text`'s last line terminator is, or -1 where it has none. */
const lastLineTerminator = (/** @type {string} */ text) =>
	Math.max(...LINE_TERMINATORS.map((c) => text.lastIndexOf(c)));

module.exports = {
	LINE_TERMINATORS,
	firstLineTerminator,
	hasLineTerminator,
	lastLineTerminator,
};
