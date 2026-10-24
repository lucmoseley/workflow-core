/**
 * The fail-open log's writer for one evidence-reading limb, required at the
 * limb rather than at the top so that a library that will not load costs a
 * missed check, never a dead turn (mantahostels#1253). Null where the arbiter store
 * itself will not load: the limb then fails open unreported, having nothing to
 * write with.
 * @param {string} where the log's second field, which check-guard-errors.js
 *   groups on
 * @returns {((what: string) => void) | null}
 */
function failOpenLogger(where) {
	let store;
	try {
		store = require("./arbiter-store");
	} catch {
		return null;
	}
	return (what) => {
		try {
			store.logError(where, what);
		} catch {
			/* logging this failure has the same failure mode */
		}
	};
}

module.exports = { failOpenLogger };
