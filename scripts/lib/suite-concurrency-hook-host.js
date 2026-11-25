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
		climbMb: (scope) =>
			require("./suite-queue.js").readQueuesClimbMb(scope, {
				onUnread: (/** @type {string} */ dir, /** @type {unknown} */ error) =>
					log(
						`${dir} unreadable — its launches' climb charged none (workflow-core#3488)`,
						String(error),
					),
			}),
	};
}

module.exports = { buildHostPorts };
