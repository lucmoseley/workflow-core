/*
 * suite-concurrency-hook-host.js — the ports the dispatcher wires into the
 * guard-suite-concurrency core: lib/suite-concurrency-host.js's, and what the
 * queues' running launches have yet to draw (workflow-core#3488).
 *
 * A FILE APART, since the queue reads lib/suite-concurrency-host.js's
 * `readGate` and this one reads the queue.
 */

const {
	buildHostPorts: buildSharedPorts,
} = require("./suite-concurrency-host.js");

/**
 * @param {string} root
 * @param {(what: string, detail?: string) => void} log
 * @returns {import("./suite-concurrency.js").SuitePorts}
 */
function buildHostPorts(root, log) {
	return {
		...buildSharedPorts(root, log),
		/* Required at the call: most commands this core sees launch nothing
		 * it judges. */
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
