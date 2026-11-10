/*
 * review-hour.js — the hour the morning review falls due, apart from
 * lib/morning-review.js's report so the loop's decision libs, which only time
 * things by it, load none of the report's modules (#4821).
 */

/* Untraced: spec #1995's "first tick after 07:00", machine-local. */
const REVIEW_HOUR = 7;

module.exports = { REVIEW_HOUR };
