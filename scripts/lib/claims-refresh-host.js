function buildHostPorts() {
	return {
		/** @param {string} session */
		refreshClaims: (session) =>
			require("./arbiter-tool-record.js").refreshAfterBash(session),
	};
}

module.exports = { buildHostPorts };
