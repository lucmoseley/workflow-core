/*
 * founder-deliverable.js — the founder-deliverable rule as the inventory and
 * ceiling guards print it (#1044): in full, as a stand-in where its fragment
 * cannot be read, or as the pointer a repeat block prints instead.
 */

const { rulePointer, readRuleTextOr } = require("./rule-text.js");

const ID = "founder-deliverable";

/**
 * @param {string} label the guard, as the error log names it
 * @returns {string}
 */
const readDeliverableRule = (label) =>
	readRuleTextOr(
		"founder-deliverable",
		"A founder-facing item lives in an open issue, filed the moment it exists: `takes:human` for an act outside Claude Code, with a `**Close when:**` line; `takes:wayfinder` with a `## Question` body for a check by eye or an unanswered decision",
		label,
	);

/** @returns {string} */
const deliverablePointer = () => rulePointer(ID);

module.exports = { deliverablePointer, readDeliverableRule };
