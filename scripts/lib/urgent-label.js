/*
 * urgent-label.js — the `urgent` label's name, and the rule for how far an
 * issue passes its tiers down its sub-issue chain (#3653).
 *
 * pick-next.js applies the rule to each parent link, and file-issue.js to the
 * ancestors it walks when refusing a hard-coded `urgent`. pick-next lists only
 * open issues, so a change that lets a closed issue pass down must also read
 * closed parents there.
 */

const URGENT_LABEL = "urgent";

/**
 * Whether what `issue` carries, or inherits from its own parent, reaches its
 * children: only an open issue's does, so a closed ancestor ends the chain
 * (#3250, #3637).
 * @param {{state: string}} issue
 */
const isPassingDown = (issue) => issue.state === "open";

module.exports = { URGENT_LABEL, isPassingDown };
