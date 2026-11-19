/*
 * release-due.js — when the weekly release cut falls due (#5435), as a pure
 * core over a reading of the last tag. release-plugin.js refuses a cut under
 * CADENCE_DAYS after the last tag (founder ruling #5223 Q1 (A));
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
 * @typedef {{ due: boolean, next: string, why: string }} CutVerdict
 */

/**
 * Due once CADENCE_DAYS have passed since the tag and `origin/main` holds a
 * commit it does not carry.
 *
 * @param {CutReading} reading
 * @param {number} nowMs
 * @returns {CutVerdict}
 */
function judgeCut({ tag, cutSec, commits }, nowMs) {
	const nextMs = cutSec * 1000 + CADENCE_DAYS * DAY_MS;
	const days = (nowMs - cutSec * 1000) / DAY_MS;
	const next = new Date(nextMs).toISOString().slice(0, 16).replace("T", " ");
	const gap = `${tag} was cut ${days.toFixed(1)} days ago`;
	if (nowMs < nextMs)
		return {
			due: false,
			next,
			why: `${gap}, under the ${CADENCE_DAYS}-day cadence; a cut is allowed from ${next} UTC`,
		};
	if (commits === 0)
		return {
			due: false,
			next,
			why: `${gap}, but origin/main holds no commit it does not carry`,
		};
	return {
		due: true,
		next,
		why: `${gap}, and origin/main holds ${commits} commit(s) it does not carry`,
	};
}

module.exports = { CADENCE_DAYS, CUT_TITLE, judgeCut };
