const { takesLabel } = require("./takes-label.js");

const WAYFINDER_PREFIX = "wayfinder:";
const TAKES_WAYFINDER = takesLabel("wayfinder");

/** @param {string} label */
const isDecisionLabel = (label) =>
	label === TAKES_WAYFINDER || label.startsWith(WAYFINDER_PREFIX);

/**
 * @param {string[]} labels
 * @returns {boolean}
 */
const isRouteStep = (labels) =>
	labels.some((l) => l.startsWith(WAYFINDER_PREFIX));

/**
 * @param {string[]} labels
 * @returns {string[]}
 */
const decisionMarks = (labels) => labels.filter(isDecisionLabel);

/**
 * @param {string[]} labels
 * @returns {boolean}
 */
const isDecisionTicket = (labels) => labels.some(isDecisionLabel);

module.exports = { decisionMarks, isDecisionTicket, isRouteStep };
