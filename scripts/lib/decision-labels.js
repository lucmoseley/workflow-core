/*
 * decision-labels.js — whether an issue is a decision ticket, read from its
 * labels (#4740). A new decision label lands here, and every script that
 * tells a decision ticket from a build ticket reads it through this file.
 */

const { takesLabel } = require("./takes-label.js");

const WAYFINDER_PREFIX = "wayfinder:";
const TAKES_WAYFINDER = takesLabel("wayfinder");

/**
 * A step on a map's route: any `wayfinder:` label, `wayfinder:map` included.
 * @param {string[]} labels
 * @returns {boolean}
 */
const isRouteStep = (labels) =>
	labels.some((l) => l.startsWith(WAYFINDER_PREFIX));

/**
 * A decision ticket: `takes:wayfinder` or any `wayfinder:` label.
 * @param {string[]} labels
 * @returns {boolean}
 */
const isDecisionTicket = (labels) =>
	labels.includes(TAKES_WAYFINDER) || isRouteStep(labels);

/**
 * The labels that make `labels` a decision ticket, in their own order.
 * @param {string[]} labels
 * @returns {string[]}
 */
const decisionMarks = (labels) =>
	labels.filter((l) => l === TAKES_WAYFINDER || l.startsWith(WAYFINDER_PREFIX));

module.exports = { decisionMarks, isDecisionTicket, isRouteStep };
