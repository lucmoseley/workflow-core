const { readParkMarkersOrThrow } = require("./parked.js");
const { readState } = require("./refill-state.js");

const HOLD_FIELDS = /** @type {const} */ (["limitHeld", "stepResume"]);

/**
 * @param {string} root
 * @returns {Set<string>}
 */
function readSessionsResumeExpected(root) {
	const { launches } = readState((line) => {
		throw new Error(line);
	});
	const launched = launches
		.filter((l) => l.finishedAt === null)
		.flatMap((l) => [l.sessionId, ...HOLD_FIELDS.map((f) => l[f]?.sessionId)]);
	return new Set([
		...launched.filter((id) => typeof id === "string"),
		...readParkMarkersOrThrow(root).map((m) => m.sessionId),
	]);
}

module.exports = { readSessionsResumeExpected };
