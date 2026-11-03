/*
 * resume-expected.js — the sessions the refill loop still expects to resume, for
 * the marker sweep to spare their pass markers through a hold of any length
 * (#4110): each unfinished launch's session, and each session with a park in
 * `root`'s checkout.
 *
 * A leaf, reading the state's raw JSON: lib/refill-files.js's reader loads the
 * arbiter store, which the sweep is part of.
 */

const fs = require("node:fs");
const { caught } = require("./caught.js");
const { readParkMarkersOrThrow } = require("./parked.js");
const { REFILL_STATE_FILE, refillPath } = require("./refill-dir.js");

/* The fields a held launch keeps the session its resume will name. */
const HOLD_FIELDS = ["limitHeld", "swapHeld", "holdCleared", "bootKilled"];

/**
 * The raw launch rows; none where the loop has no state or the state has no
 * launches yet, as lib/refill-files.js's recordRunHeld can leave it.
 * @returns {Record<string, any>[]}
 */
function readLaunchRows() {
	let raw;
	try {
		raw = fs.readFileSync(refillPath(REFILL_STATE_FILE), "utf8");
	} catch (err) {
		if (caught(err).code === "ENOENT") return [];
		throw err;
	}
	const { launches = [] } = JSON.parse(raw);
	if (!Array.isArray(launches))
		throw new Error(`${REFILL_STATE_FILE}: launches is not a list`);
	return launches;
}

/**
 * Throws where the loop's state or a park marker will not read.
 * @param {string} root
 * @returns {Set<string>}
 */
function readSessionsResumeExpected(root) {
	const launched = readLaunchRows()
		.filter((l) => l?.finishedAt === null)
		.flatMap((l) => [l.sessionId, ...HOLD_FIELDS.map((f) => l[f]?.sessionId)]);
	return new Set([
		...launched.filter((id) => typeof id === "string"),
		...readParkMarkersOrThrow(root).map((m) => m.sessionId),
	]);
}

module.exports = { readSessionsResumeExpected };
