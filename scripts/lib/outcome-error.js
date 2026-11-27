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

/** @param {unknown} e */
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
