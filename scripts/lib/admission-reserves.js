/*
 * admission-reserves.js — the machine-wide reserves `lib/admission.js` holds
 * memory or slots back for, read live in one call, so both its callers
 * (`scripts/admission.js` and `scripts/pick-next.js`) pass one input and a new
 * reserve is added here and in `machineAdmission` alone (#5281). Apart from
 * `lib/admission.js` because both readers' modules require it.
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
