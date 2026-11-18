/*
 * review-suffix.js — the suffix a session-scoped scratch name carries: `-`
 * and the session id's first eight characters, each outside `[A-Za-z0-9_-]`
 * made `_`. Split out of write-review-marker.js so the scratch-overwrite core
 * names the same suffix (workflow-core#2789). lib/review-suffix.sh is the bash twin; review-suffix.test.ts holds
 * the routes to one answer. `segment` is that fold alone, which the
 * scratch-overwrite record and guard-entry.js's latch names spell ids by.
 */

/** @param {string} s */
const segment = (s) => s.replace(/[^A-Za-z0-9_-]/g, "_");

/** @param {string} sid */
const reviewSuffix = (sid) => `-${segment(sid).slice(0, 8)}`;

module.exports = { reviewSuffix, segment };
