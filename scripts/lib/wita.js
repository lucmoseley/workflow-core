/*
 * wita.js — the one clock this repo writes dates on.
 *
 * Every date written into a tracked document is en-GB in the founder's local
 * time zone: Lombok, WITA, UTC+8, no DST. A script ageing such a date must
 * therefore reckon "today" on the same clock, never on UTC — mantahostels#919, the marker
 * written in the WITA evening that read as dated tomorrow and failed CI.
 *
 * Offsets are arithmetic rather than `Intl` with `Asia/Makassar`: the answer
 * does not then depend on the tz database a CI runner happens to ship.
 *
 * A written date carries no time, so ages come out in whole calendar days.
 */

const WITA_OFFSET_MS = 8 * 3_600_000;

/**
 * The WITA calendar date containing `at`, as the UTC-midnight timestamp that
 * `Date.UTC(y, m, d)` gives a date parsed out of a document — so the two are
 * directly comparable.
 */
function witaDay(at = Date.now()) {
	const shifted = new Date(at + WITA_OFFSET_MS);
	return Date.UTC(
		shifted.getUTCFullYear(),
		shifted.getUTCMonth(),
		shifted.getUTCDate(),
	);
}

/**
 * Whole WITA calendar days from a document-written date to `at`. Nought on the
 * day it was written, and negative only for a date genuinely ahead of the
 * calendar — never for a clock skew.
 *
 * `day` is a UTC-midnight timestamp, the form `Date.UTC(y, m, d)` returns.
 *
 * @param {number} day
 * @param {number} [at]
 */
function calendarDaysSince(day, at = Date.now()) {
	return (witaDay(at) - day) / 86_400_000;
}

module.exports = { witaDay, calendarDaysSince };
