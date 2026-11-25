const { ignoreFailure } = require("./caught.js");

/**
 * lucmoseley/mantahostels#1253
 * @param {string} where
 * @returns {((what: string) => void) | null}
 */
function failOpenLogger(where) {
	let store;
	try {
		store = require("./arbiter-store");
	} catch {
		return null;
	}
	return (what) => ignoreFailure(() => store.logError(where, what));
}

module.exports = { failOpenLogger };
