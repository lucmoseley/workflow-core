/*
 * resume-expected.js — the sessions the refill loop still expects to resume, for
 * the marker sweep to spare their pass markers through a hold of any length
 * (workflow-core#4110): each unfinished launch's session, and each session with a park in
 * `root`'s checkout.
 */

const { readParkMarkersOrThrow } = require("./parked.js");
const { readState } = require("./refill-state.js");

/* The fields a held launch keeps the session its resume will name. */
const HOLD_FIELDS = /** @type {const} */ (["limitHeld", "stepResume"]);

/**
 * Throws where the loop's state, one of its launch rows or a park marker will
 * not read.
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
