/*
 * decision-labels.js — whether an issue is a decision ticket, read from its
 * labels (#4740). A new decision label lands in `isDecisionLabel`, and every
 * script that tells a decision ticket from a build ticket reads it through
 * this file; scripts/place-new-issue.sh, being shell, hand-copies
 * `isRouteStep`.
 */

const { takesLabel } = require("./takes-label.js");

const WAYFINDER_PREFIX = "wayfinder:";
const TAKES_WAYFINDER = takesLabel("wayfinder");

/** @param {string} label */
const isDecisionLabel = (label) =>
	label === TAKES_WAYFINDER || label.startsWith(WAYFINDER_PREFIX);

/**
 * A step on a map's route: any `wayfinder:` label, `wayfinder:map` included.
 * @param {string[]} labels
 * @returns {boolean}
 */
const isRouteStep = (labels) =>
	labels.some((l) => l.startsWith(WAYFINDER_PREFIX));

/**
 * The labels that make `labels` a decision ticket, in their own order.
 * @param {string[]} labels
 * @returns {string[]}
 */
const decisionMarks = (labels) => labels.filter(isDecisionLabel);

/**
 * A decision ticket: `takes:wayfinder` or any `wayfinder:` label.
 * @param {string[]} labels
 * @returns {boolean}
 */
const isDecisionTicket = (labels) => labels.some(isDecisionLabel);

module.exports = { decisionMarks, isDecisionTicket, isRouteStep };
