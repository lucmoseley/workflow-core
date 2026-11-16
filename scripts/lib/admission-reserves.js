/*
 * admission-reserves.js — the reserves `lib/admission.js` reads live off
 * other processes' records, in one call both its callers make (#5281). A new
 * one is a field here, in `lib/admission.js`'s `Reserves` typedef and, where
 * it holds memory, a price in its `reservesHeldMb` and a named field through
 * the verdict's figures (#5297). Apart from `lib/admission.js` because both
 * readers' modules require it.
 */

const { readLiveLanders } = require("./local-tester.js");
const {
	readLiveGateSeats,
	readTestsHeldOnWindows,
} = require("./suite-queue.js");

/**
 * The landers, the gate seats and the queued test runs the Windows-memory
 * hold is holding.
 * @returns {import("./admission.js").Reserves}
 */
const readReserves = () => ({
	landers: readLiveLanders(),
	gates: readLiveGateSeats(),
	testsHeld: readTestsHeldOnWindows(),
});

module.exports = { readReserves };
