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
