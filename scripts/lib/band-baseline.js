/*
 * band-baseline.js — the price-band and top-figure readings
 * `check-band-drift.js` measures drift against, and the samples under which
 * it files nothing (#487, #2260).
 *
 * Its own module so the reporter's tests build their fixtures from these
 * figures, and a re-measured baseline moves no test.
 */

/*
 * MOVE IT ONLY WITH A RE-MEASUREMENT, taken by check-band-drift.js over a
 * 14-day window with no close-rivals limb live. Both thresholds are half of it
 * (measured at #487, on #472's ruling).
 */
const BAND_BASELINE = {
	overlapShare: 39 / 170,
	medianHalfWidth: 10,
	questions: 1682,
	band: 170,
	window: "13–27 Sep 2026",
	date: "27 Sep 2026",
};

/*
 * Under this many band questions the share is noise: at 100, a true baseline
 * share reads under its drift floor by chance 0.18% of the time (binomial,
 * #487).
 */
const MIN_BAND_SAMPLE = 100;

/*
 * MOVE IT ONLY WITH A RE-MEASUREMENT, taken by check-band-drift.js's reading
 * over a 14-day window with no low-top test live: the priced question blocks
 * of every shape whose top figure sits at exactly `LOW_TOP` + 5 (#2519).
 */
const TOP_BASELINE = {
	atLine: 527,
	tops: 3067,
	window: "5–19 Oct 2026",
};

/*
 * Under this many priced tops the share is noise: at 300, a true baseline
 * share reads over 1.5 times itself by chance 0.008% of the time (binomial,
 * #2260, #2519).
 */
const MIN_TOP_SAMPLE = 300;

module.exports = {
	BAND_BASELINE,
	MIN_BAND_SAMPLE,
	TOP_BASELINE,
	MIN_TOP_SAMPLE,
};
