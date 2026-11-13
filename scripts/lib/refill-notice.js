/*
 * refill-notice.js — what `refill-loop.js` refuses or warns of, and what the
 * panel says of a press, as data (workflow-core#3968,
 * spec workflow-core#3596): its reason, its remedy and the repo box at fault held apart, so the
 * panel reads `set --json` rather than the prose. Joins no §N3 family: it gates
 * nothing and is no hook.
 */

/**
 * @typedef {{reason: string, remedy: string|null, box: string|null}} Notice
 *   `box`, the directory name of the checkout whose tick box is at fault
 */

/**
 * @param {string} reason
 * @param {string|null} [remedy]
 * @param {string|null} [box]
 * @returns {Notice}
 */
const buildNotice = (reason, remedy = null, box = null) => ({
	reason,
	remedy,
	box,
});

/**
 * @param {unknown} value
 * @returns {value is Notice}
 */
const isNotice = (value) =>
	typeof value === "object" && value !== null && "reason" in value;

/** @param {Pick<Notice, "reason"|"remedy">} refusal the words on one line */
const buildNoticeText = ({ reason, remedy }) =>
	remedy === null ? reason : `${reason}; ${remedy}`;

module.exports = { buildNotice, buildNoticeText, isNotice };
