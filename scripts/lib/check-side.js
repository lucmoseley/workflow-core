/*
 * check-side.js — the env var naming which side of a fault diff a checker run
 * reads: `baseline` on the older revision's, `index` on the newer's. A checker
 * skips work feeding only an `indexOnly` finding on the baseline side
 * (lib/check.js isBaselineSide()), which the diff never compares (#2056).
 * Alone in a module so a hook can set it without loading lib/check.js
 * (#4297). A stopgap: lib/check.js still names it itself, until #4325 has it
 * require this file.
 */
const SIDE_ENV = "WFC_CHECK_SIDE";

module.exports = { SIDE_ENV };
