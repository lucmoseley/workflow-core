const WITA_OFFSET_MS = 8 * 3_600_000;

function witaDay(at = Date.now()) {
	const shifted = new Date(at + WITA_OFFSET_MS);
	return Date.UTC(
		shifted.getUTCFullYear(),
		shifted.getUTCMonth(),
		shifted.getUTCDate(),
	);
}

/**
 * @param {number} day
 * @param {number} [at]
 */
function calendarDaysSince(day, at = Date.now()) {
	return (witaDay(at) - day) / 86_400_000;
}

module.exports = { witaDay, calendarDaysSince };
