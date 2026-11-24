const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const NEVER = Number.NEGATIVE_INFINITY;

/**
 * @param {number} ms
 * @param {{ minutesUnder?: number }} [edges]
 * @returns {string}
 */
function describeAge(ms, { minutesUnder = 90 * MINUTE_MS } = {}) {
	if (ms < minutesUnder) return `${Math.floor(ms / MINUTE_MS)}m`;
	if (ms < 48 * HOUR_MS) return `${Math.floor(ms / HOUR_MS)}h`;
	return `${Math.floor(ms / DAY_MS)}d`;
}

module.exports = { describeAge, HOUR_MS, MINUTE_MS, NEVER };
