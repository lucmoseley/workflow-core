/*
 * check-side.js — the env var naming which side of an --against run a checker
 * child reads: `baseline` on the <rev> side, `index` on the commit's. Set by
 * lib/check.js's re-exec and by report-new-shared-faults.js, so a checker can
 * skip work that feeds only a non-gating finding on the baseline side — a
 * network lookup, say — and its profile marks that finding `indexOnly` so the
 * diff never reads the gap as new (#2056). Alone in a module so a hook can set
 * it without loading lib/check.js (#4297).
 */
const SIDE_ENV = "WFC_CHECK_SIDE";

module.exports = { SIDE_ENV };
