/*
 * check-side.js — the env var naming which side of a fault diff a checker run
 * reads: `baseline` on the older revision's, `index` on the newer's. A checker
 * reads it through lib/check.js isBaselineSide() to skip work that feeds only
 * a non-gating finding on the baseline side — a network lookup, say — and its
 * profile marks that finding `indexOnly` so the diff never reads the gap as
 * new (workflow-core#2056). Alone in a module so a hook can set it without loading
 * lib/check.js (workflow-core#4297).
 */
const SIDE_ENV = "WFC_CHECK_SIDE";

module.exports = { SIDE_ENV };
