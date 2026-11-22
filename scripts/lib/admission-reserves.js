const { readLiveLanders } = require("./local-tester.js");
const {
	readLiveGateSeats,
	readTestsHeldOnWindows,
} = require("./suite-queue.js");

/** @returns {import("./admission.js").Reserves} */
const readReserves = () => ({
	landers: readLiveLanders(),
	gates: readLiveGateSeats(),
	testsHeld: readTestsHeldOnWindows(),
});

module.exports = { readReserves };
