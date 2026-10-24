/*
 * founder-deliverable.js — the founder-deliverable rule as the inventory and
 * ceiling guards print it (#1044): in full, as a stand-in where its fragment
 * cannot be read, or as the pointer a repeat block prints instead.
 */

const { rulePointer, ruleTextOr } = require("./rule-text.js");

const ID = "founder-deliverable";

const FALLBACK =
	"A founder-facing item lives in an open issue, filed the moment it exists: `takes:human` for an act outside Claude Code, with a `**Close when:**` line; `takes:wayfinder` with a `## Question` body for a check by eye or an unanswered decision.";

/**
 * @param {string} label the guard, as the error log names it
 * @returns {string}
 */
const deliverableRule = (label) => ruleTextOr(ID, FALLBACK, label);

/** @returns {string} */
const deliverablePointer = () => rulePointer(ID);

module.exports = { deliverablePointer, deliverableRule };
