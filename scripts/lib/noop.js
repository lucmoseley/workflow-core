/*
 * noop.js — the callback for a hook or listener a caller must pass but has no
 * use for.
 */

/** @returns {undefined} */
const noop = () => undefined;

module.exports = { noop };
