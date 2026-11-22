/*
 * release-due.js — when the weekly release cut falls due (workflow-core#5435), as a pure
 * core over a reading of the last tag. release-plugin.js refuses a cut under
 * CADENCE_DAYS after the last tag (founder ruling workflow-core#5223 Q1 (A));
 * report-release-due.js files the cut ticket once one is allowed and owed.
 */

/** The release cadence: days from one tag before the next cut runs unasked. */
const CADENCE_DAYS = 7;
const DAY_MS = 86_400_000;
const CUT_TITLE = "Release cut due";

/**
 * @typedef {{ tag: string, cutSec: number, commits: number }} CutReading
 *   `cutSec` is the tag's tagger date in epoch seconds; `commits` how many
 *   commits `origin/main` holds past the tag's source.
 * @typedef {{ due: boolean, why: string }} CutVerdict
 */

/**
 * Days from a tag's cut to `nowMs`, fractional.
 * @param {number} cutSec
 * @param {number} nowMs
 */
const daysSinceCut = (cutSec, nowMs) => (nowMs - cutSec * 1000) / DAY_MS;

/**
 * Due once CADENCE_DAYS have passed since the tag and `origin/main` holds a
 * commit it does not carry.
 *
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
