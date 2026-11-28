/** @typedef {{reason: string, remedy: string|null, box: string|null}} Notice */

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

/** @param {Pick<Notice, "reason"|"remedy">} refusal */
const buildNoticeText = ({ reason, remedy }) =>
	remedy === null ? reason : `${reason}; ${remedy}`;

const LOOP_NOTICE_PREFIX = "Refill loop: ";

/** @param {string|undefined} body */
const isLoopNotice = (body) =>
	(body ?? "").replace(/^\*\*/, "").startsWith(LOOP_NOTICE_PREFIX);

module.exports = {
	LOOP_NOTICE_PREFIX,
	buildNotice,
	buildNoticeText,
	isLoopNotice,
	isNotice,
};
