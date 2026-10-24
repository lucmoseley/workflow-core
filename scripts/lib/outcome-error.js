/*
 * outcome-error.js — the SKIP and BROKEN errors a checker throws and
 * lib/check.js folds into its outcome. Apart from check.js because that
 * module installs process-wide crash handlers on load, which a program
 * reading git through lib/git-objects.js must not inherit (#2493).
 */

/* Thrown, not exited, so lib/check.js's runCheck stays the single place a process ends. The
 * outcome sits here, not on a subclass: one class a file (#1381). */
/** @type {WeakMap<Error, "SKIP" | "BROKEN">} */
const thrownOutcome = new WeakMap();

/**
 * @param {string} message
 * @param {"SKIP" | "BROKEN"} outcome
 * @param {ErrorOptions} [options]
 */
function outcomeError(message, outcome, options) {
	const error = new Error(message, options);
	thrownOutcome.set(error, outcome);
	return error;
}

/** @param {string} message */
function skipError(message) {
	return outcomeError(message, "SKIP");
}

/**
 * @param {string} message
 * @param {ErrorOptions} [options]
 */
function brokenError(message, options) {
	return outcomeError(message, "BROKEN", options);
}

/**
 * Whether `e` already carries its outcome, so a wrapper passes it on rather
 * than re-reading it as a fault of its own.
 * @param {unknown} e
 */
function isOutcomeError(e) {
	return e instanceof Error && thrownOutcome.has(e);
}

/** @param {Error} e */
const outcomeOf = (e) => thrownOutcome.get(e);

module.exports = {
	brokenError,
	isOutcomeError,
	outcomeOf,
	skipError,
};
