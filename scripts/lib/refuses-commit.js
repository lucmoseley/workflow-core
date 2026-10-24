/*
 * refuses-commit.js — the field check-guard-registry.js sets on a WARN its
 * pre-commit gate refuses, in the one place the checker and
 * checker-new-faults.js's profile both read (#2617). Renaming it on one side
 * alone would stop the gate refusing in silence.
 */

/** Set `true` on a staleness warning; the `guard-registry` profile gates on it. */
const REFUSES_COMMIT = "refusesCommit";

module.exports = { REFUSES_COMMIT };
