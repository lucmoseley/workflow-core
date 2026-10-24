/*
 * standalone-line.js — whether an issue body records why it has no parent, as
 * the `Standalone:` line `file-issue.js --standalone` writes (#1027). Shared so
 * the line the filer writes and the line the orphan check accepts cannot drift
 * apart (#1615).
 *
 * Residual: a line inside a quote or code fence counts.
 */

/** @param {string | null | undefined} body */
const hasStandaloneLine = (body) => /^\s*Standalone:/m.test(body || "");

module.exports = { hasStandaloneLine };
