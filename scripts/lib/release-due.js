// guess, #5435
const CADENCE_DAYS = 7;
const DAY_MS = 86_400_000;
const CUT_TITLE = "Release cut due";

/**
 * @typedef {{ tag: string, cutSec: number, commits: number }} CutReading
 * @typedef {{ due: boolean, why: string }} CutVerdict
 */

/**
 * @param {number} cutSec
 * @param {number} nowMs
 */
const daysSinceCut = (cutSec, nowMs) => (nowMs - cutSec * 1000) / DAY_MS;

/**
 * @param {CutReading} reading
 * @param {number} nowMs
 * @returns {CutVerdict}
 */
function judgeCut({ tag, cutSec, commits }, nowMs) {
	const days = daysSinceCut(cutSec, nowMs);
	const gap = `${tag} was cut ${days.toFixed(1)} days ago`;
	if (days < CADENCE_DAYS) {
		const from = new Date(cutSec * 1000 + CADENCE_DAYS * DAY_MS)
			.toISOString()
			.slice(0, 16)
			.replace("T", " ");
		return {
			due: false,
			why: `${gap}, under the ${CADENCE_DAYS}-day cadence; a cut is allowed from ${from} UTC`,
		};
	}
	if (commits === 0)
		return {
			due: false,
			why: `${gap}, but origin/main holds no commit it does not carry`,
		};
	return {
		due: true,
		why: `${gap}, and origin/main holds ${commits} commit(s) it does not carry`,
	};
}

module.exports = { CADENCE_DAYS, CUT_TITLE, daysSinceCut, judgeCut };
