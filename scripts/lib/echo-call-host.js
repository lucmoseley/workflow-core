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
