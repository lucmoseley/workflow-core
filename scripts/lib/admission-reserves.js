const { hostRoot } = require("./host-root.js");
const { readLiveLanders } = require("./local-tester.js");
const {
	readLiveGateSeats,
	readLiveTypechecks,
	readTestsHeldOnMemory,
	readTestsHeldOnWindows,
} = require("./suite-queue.js");
const { checkoutPeakMb } = require("./tsc-slot.js");

/** @returns {import("./admission.js").Reserves} */
const readReserves = () => ({
	landers: readLiveLanders(),
	gates: readLiveGateSeats(),
	heldRuns: readTestsHeldOnMemory(),
	typechecks: readLiveTypechecks({
		unreadMb: () => checkoutPeakMb(hostRoot()),
	}),
	testsHeld: readTestsHeldOnWindows(),
});

module.exports = { readReserves };
