/*
 * suite-concurrency-hook-host.js — the ports the dispatcher wires into the
 * guard-suite-concurrency core: lib/suite-concurrency-host.js's, what the
 * queues' running launches have yet to draw (#3488), and the live gate seats
 * (#5274).
 *
 * A FILE APART, since the queue reads lib/suite-concurrency-host.js's
 * `readGate` and this one reads the queue.
 */

const {
	buildHostPorts: buildSharedPorts,
} = require("./suite-concurrency-host.js");

/**
 * @param {import("./core-contract.js").HostEnv} env
 * @returns {import("./suite-concurrency.js").SuitePorts}
 */
function buildHostPorts({ root, log }) {
	return {
		...buildSharedPorts(root, log),
		gateSeats: () => require("./suite-queue.js").readGateSeats(),
		/* Required at the call: most commands this core sees launch nothing
		 * it judges. */
		climbMb: (scope) =>
			require("./suite-queue.js").readQueuesClimbMb(scope, {
				onUnread: (/** @type {string} */ dir, /** @type {unknown} */ error) =>
					log(
						`${dir} unreadable — its launches' climb charged none (#3488)`,
						String(error),
					),
			}),
	};
}

module.exports = { buildHostPorts };
