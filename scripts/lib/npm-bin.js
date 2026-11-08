/*
 * npm-bin.js — the `npm` program to run: WFC_NPM, else `npm`. Overridable so a
 * suite can stand a fake registry client in (docs/code-standards-base.md).
 * Read per call, not frozen at load: the sandbox re-points it between tests.
 */

/** @param {NodeJS.ProcessEnv} [env] */
const npmBin = (env = process.env) => env.WFC_NPM || "npm";

module.exports = { npmBin };
