const LOOP_COMMENT_PREFIX = "Refill loop: ";

/** @param {string} text */
const buildLoopComment = (text) => `${LOOP_COMMENT_PREFIX}${text}`;

/** @param {string|undefined} body */
const isLoopComment = (body) =>
	(body ?? "").replace(/^\*\*/, "").startsWith(LOOP_COMMENT_PREFIX);

module.exports = { LOOP_COMMENT_PREFIX, buildLoopComment, isLoopComment };
