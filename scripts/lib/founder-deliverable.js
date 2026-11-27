const { rulePointer, readRuleTextOr } = require("./rule-text.js");

const ID = "founder-deliverable";

/**
 * @param {string} label
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
