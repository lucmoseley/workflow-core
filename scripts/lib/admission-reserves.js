const { readLiveLanders } = require("./local-tester.js");
const {
	readLiveGateSeats,
	readTestsHeldOnMemory,
	readTestsHeldOnWindows,
} = require("./suite-queue.js");

/** @returns {import("./admission.js").Reserves} */
const readReserves = () => ({
	landers: readLiveLanders(),
	gates: readLiveGateSeats(),
	heldRuns: readTestsHeldOnMemory(),
	testsHeld: readTestsHeldOnWindows(),
});

module.exports = { readReserves };
