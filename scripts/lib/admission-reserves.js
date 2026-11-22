/*
 * admission-reserves.js — the reserves `lib/admission.js` reads live off
 * other processes' records, in one call both its callers make (#5281). A new
 * one is a field here, in `lib/admission.js`'s `Reserves` typedef and, where
 * it holds memory, an entry in its `heldReserves` (#5297). Apart from
 * `lib/admission.js` because both readers' modules require it.
 */

const { readLiveLanders } = require("./local-tester.js");
const {
	readLiveGateSeats,
	readTestsHeldOnMemory,
	readTestsHeldOnWindows,
} = require("./suite-queue.js");

/**
 * @returns {import("./admission.js").Reserves}
 */
const readReserves = () => ({
	landers: readLiveLanders(),
	gates: readLiveGateSeats(),
	heldRuns: readTestsHeldOnMemory(),
	testsHeld: readTestsHeldOnWindows(),
});

module.exports = { readReserves };
