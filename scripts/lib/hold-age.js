/*
 * hold-age.js — a repo hold's age as the founder reads it, the one wording
 * `status`, the morning review and the loop panel share (#3860, #4736).
 */

/**
 * @param {number} ms
 */
function buildAgeText(ms) {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	return minutes < 60
		? `${minutes}m`
		: `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

module.exports = { buildAgeText };
