/*
 * age-text.js — an age as one figure and its unit, "40m", "18h", "11d", the
 * wording every report of a process's, job's, claim's or edit's age shares
 * (#4703, which folded five copies). Minutes under `minutesUnder`, hours
 * under 48 h, else days: the edges are a judgement, so no figure prints above
 * 90 or 48 of its unit. A caller that never prints minutes passes
 * `minutesUnder: NEVER`, which a clock-skewed negative age stays under too.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const NEVER = Number.NEGATIVE_INFINITY;

/**
 * @param {number} ms
 * @param {{ minutesUnder?: number }} [edges] in ms; 90 minutes where absent
 * @returns {string}
 */
function describeAge(ms, { minutesUnder = 90 * MINUTE_MS } = {}) {
	if (ms < minutesUnder) return `${Math.floor(ms / MINUTE_MS)}m`;
	if (ms < 48 * HOUR_MS) return `${Math.floor(ms / HOUR_MS)}h`;
	return `${Math.floor(ms / DAY_MS)}d`;
}

module.exports = { describeAge, HOUR_MS, MINUTE_MS, NEVER };
