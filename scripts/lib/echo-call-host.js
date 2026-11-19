/*
 * echo-call-host.js — the production ports lib/echo-call.js reads through the
 * dispatcher (#2791): the clock, and the echo-chain store as the recorder
 * keeps it — the same stat, the same files and the same `<file>.dlock`
 * (lib/echo-record-host.js), so a refusal's write and the recorder's
 * serialise against each other.
 */

const recorder = require("./echo-record-host.js");

/**
 * @param {import("./core-contract.js").HostEnv} env
 */
function buildHostPorts(env) {
	return {
		now: () => Math.floor(Date.now() / 1000),
		...recorder.buildHostPorts(env),
	};
}

module.exports = { buildHostPorts };
