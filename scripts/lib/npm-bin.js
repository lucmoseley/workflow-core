/*
 * npm-bin.js — the `npm` program to run: WFC_NPM, else `npm` (#4256, #4261).
 * Overridable so a suite can stand a fake in (docs/code-standards-base.md).
 * Read per call, not frozen at load: the sandbox re-points it between tests.
 */

const npmBin = () => process.env.WFC_NPM || "npm";

module.exports = { npmBin };
