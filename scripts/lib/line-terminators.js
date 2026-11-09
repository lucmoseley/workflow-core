/*
 * line-terminators.js — the characters a regex's `.` and `$` (under `m`) stop
 * at: ECMAScript's LineTerminator set. For code that reads a line by index
 * where a regex would have kept `.` from crossing one (#4647).
 */

const LINE_TERMINATORS = ["\n", "\r", "\u2028", "\u2029"];

/** Whether `text` holds a line terminator. */
const hasLineTerminator = (/** @type {string} */ text) =>
	LINE_TERMINATORS.some((c) => text.includes(c));

module.exports = { LINE_TERMINATORS, hasLineTerminator };
